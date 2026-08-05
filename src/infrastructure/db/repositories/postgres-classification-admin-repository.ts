import type { JsonObject, ReferenceCandidateDTO } from "../../../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError } from "../../../core/errors/index.js";
import type {
  ClassificationAdminRepository,
  ClassificationDecisionContext,
  ClassificationDecisionKey,
  ClassificationReferenceValueOption,
  ClassificationReviewExample,
  ClassificationReviewItem,
  ClassificationReviewQuery,
  ClassificationRuleCandidateRecord,
  CreateClassificationRuleInput,
  CreateClassificationRuleResult,
  SaveClassificationDecisionInput,
  SaveClassificationDecisionResult,
} from "../../../repositories/index.js";
import type { SqlClient, SqlPool } from "../sql-executor.js";
import type { DatabaseRow } from "./row-mappers.js";

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function jsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function reviewExamples(value: unknown): readonly ClassificationReviewExample[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = row as Record<string, unknown>;
    return {
      observationId: String(item.observation_id),
      sourceProductId: String(item.source_product_id),
      sourceKey: String(item.source_key),
      title: nullableText(item.title),
      sku: nullableText(item.sku),
      evidence: jsonObject(item.evidence),
      targetSnapshots: Array.isArray(item.target_snapshots)
        ? item.target_snapshots.map((snapshot) => {
            const target = jsonObject(snapshot);
            return {
              targetId: String(target.target_id),
              externalId: String(target.external_id),
              snapshot: jsonObject(target.snapshot),
            };
          })
        : [],
    };
  });
}

async function withClient<Result>(
  pool: SqlPool,
  callback: (client: SqlClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function enqueueProducts(client: SqlClient, sourceProductIds: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(sourceProductIds)];
  if (uniqueIds.length === 0) return 0;
  const result = await client.query(
    `INSERT INTO jobs (job_type, payload, status, available_at, unique_key)
     SELECT
       'process_product',
       JSONB_BUILD_OBJECT('sourceProductId', product_id::TEXT, 'force', FALSE),
       'pending',
       NOW(),
       'source-product:' || product_id::TEXT || ':process'
     FROM UNNEST($1::BIGINT[]) AS product_id
     ON CONFLICT (job_type, unique_key)
       WHERE status IN ('pending', 'running', 'retry')
     DO UPDATE SET unique_key = jobs.unique_key`,
    [uniqueIds],
  );
  return result.rowCount ?? uniqueIds.length;
}

async function enqueueTargetExports(
  client: SqlClient,
  targetId: string,
  referenceValueId: string,
): Promise<number> {
  const result = await client.query(
    `INSERT INTO jobs (job_type, payload, status, available_at, unique_key)
     SELECT DISTINCT
       'export_product',
       JSONB_BUILD_OBJECT('internalProductId', internal.id::TEXT, 'targetId', $1::TEXT, 'force', FALSE),
       'pending',
       NOW(),
       'internal-product:' || internal.id::TEXT || ':target:' || $1::TEXT || ':export'
     FROM source_reference_observations observation
     JOIN internal_products internal ON internal.source_product_id = observation.source_product_id
     JOIN targets target ON target.id = $1 AND target.enabled = TRUE
     WHERE observation.active = TRUE
       AND observation.resolved_reference_value_id = $2
     ON CONFLICT (job_type, unique_key)
       WHERE status IN ('pending', 'running', 'retry')
     DO UPDATE SET unique_key = jobs.unique_key`,
    [targetId, referenceValueId],
  );
  return result.rowCount ?? 0;
}

export class PostgresClassificationAdminRepository implements ClassificationAdminRepository {
  constructor(private readonly pool: SqlPool) {}

  async listReviewQueue(query: ClassificationReviewQuery): Promise<readonly ClassificationReviewItem[]> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `WITH review_groups AS (
          SELECT
            observation.source_id,
            source.code AS source_code,
            source.name AS source_name,
            type.code AS type_code,
            type.name AS type_name,
            observation.scope,
            observation.normalized_source_value,
            observation.context_key,
            MIN(observation.source_value) AS source_value,
            MIN(observation.context::TEXT)::JSONB AS context,
            observation.status,
            MIN(observation.issue_reason) AS issue_reason,
            COUNT(*)::INTEGER AS observation_count,
            COUNT(DISTINCT observation.source_product_id)::INTEGER AS product_count,
            MIN(observation.first_seen_at) AS first_seen_at,
            MAX(observation.last_seen_at) AS last_seen_at
          FROM source_reference_observations observation
          JOIN sources source ON source.id = observation.source_id
          JOIN reference_types type ON type.id = observation.reference_type_id
          WHERE observation.active = TRUE
            AND observation.status IN ('unresolved', 'ambiguous')
            AND ($1::BIGINT IS NULL OR observation.source_id = $1)
            AND ($2::TEXT = '' OR type.code = $2)
            AND ($3::TEXT = '' OR observation.status = $3)
            AND ($4::TEXT = '' OR observation.source_value ILIKE '%' || $4 || '%')
          GROUP BY
            observation.source_id, source.code, source.name, type.code, type.name,
            observation.scope, observation.normalized_source_value,
            observation.context_key, observation.status
        )
        SELECT review_groups.*,
          COALESCE((
            SELECT JSONB_AGG(TO_JSONB(example) ORDER BY example.observation_id)
            FROM (
              SELECT
                distinct_product.observation_id,
                distinct_product.source_product_id,
                distinct_product.source_key,
                distinct_product.title,
                distinct_product.sku,
                distinct_product.evidence
              FROM (
                SELECT
                  observation.id AS observation_id,
                  product.id AS source_product_id,
                  product.source_key,
                  internal.data->>'title' AS title,
                  internal.data->>'sku' AS sku,
                  observation.evidence,
                  COALESCE((
                    SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
                      'target_id', snapshot.target_id::TEXT,
                      'external_id', snapshot.external_id,
                      'snapshot', snapshot.payload
                    ) ORDER BY snapshot.target_id)
                    FROM target_product_snapshots snapshot
                    WHERE snapshot.source_product_id = observation.source_product_id
                  ), '[]'::JSONB) AS target_snapshots,
                  observation.last_seen_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY observation.source_product_id
                    ORDER BY observation.last_seen_at DESC, observation.id
                  ) AS product_rank
                FROM source_reference_observations observation
                JOIN source_products product ON product.id = observation.source_product_id
                LEFT JOIN internal_products internal ON internal.source_product_id = product.id
                JOIN reference_types type ON type.id = observation.reference_type_id
                WHERE observation.active = TRUE
                  AND observation.source_id = review_groups.source_id
                  AND type.code = review_groups.type_code
                  AND observation.scope = review_groups.scope
                  AND observation.normalized_source_value = review_groups.normalized_source_value
                  AND observation.context_key = review_groups.context_key
                  AND observation.status = review_groups.status
              ) distinct_product
              WHERE distinct_product.product_rank = 1
              ORDER BY distinct_product.last_seen_at DESC, distinct_product.observation_id
              LIMIT 3
            ) example
          ), '[]'::JSONB) AS examples
        FROM review_groups
        ORDER BY product_count DESC, last_seen_at DESC, source_value
        LIMIT $5 OFFSET $6`,
        [query.sourceId ?? null, query.typeCode ?? "", query.status ?? "", query.search?.trim() ?? "", query.limit, query.offset],
      );

      return result.rows.map((row) => ({
        sourceId: String(row.source_id),
        sourceCode: String(row.source_code),
        sourceName: String(row.source_name),
        typeCode: String(row.type_code),
        typeName: String(row.type_name),
        scope: String(row.scope),
        normalizedSourceValue: String(row.normalized_source_value),
        contextKey: String(row.context_key),
        sourceValue: String(row.source_value),
        context: jsonObject(row.context),
        status: String(row.status) as ClassificationReviewItem["status"],
        issueReason: nullableText(row.issue_reason) as ClassificationReviewItem["issueReason"],
        observationCount: Number(row.observation_count),
        productCount: Number(row.product_count),
        firstSeenAt: timestamp(row.first_seen_at),
        lastSeenAt: timestamp(row.last_seen_at),
        examples: reviewExamples(row.examples),
      }));
    });
  }

  async listReferenceValues(
    typeCode: string,
    search: string | undefined,
    limit: number,
  ): Promise<readonly ClassificationReferenceValueOption[]> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `SELECT value.id, type.code AS type_code, value.code, value.name,
                value.parent_id, value.metadata
         FROM reference_values value
         JOIN reference_types type ON type.id = value.type_id
         WHERE value.enabled = TRUE
           AND type.enabled = TRUE
           AND type.code = $1
           AND ($2::TEXT = '' OR value.name ILIKE '%' || $2 || '%' OR value.code ILIKE '%' || $2 || '%')
         ORDER BY value.name, value.id
         LIMIT $3`,
        [typeCode, search?.trim() ?? "", limit],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        typeCode: String(row.type_code),
        code: String(row.code),
        name: String(row.name),
        parentId: nullableText(row.parent_id),
        metadata: jsonObject(row.metadata),
      }));
    });
  }

  async listRuleCandidates(
    sourceId: string,
    typeCode: string,
  ): Promise<readonly ClassificationRuleCandidateRecord[]> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `SELECT
           observation.id AS observation_id,
           observation.source_id,
           observation.source_product_id,
           product.source_key,
           internal.data->>'title' AS title,
           internal.data->>'sku' AS sku,
           observation.candidate_key,
           type.code AS type_code,
           observation.scope,
           observation.subject_kind,
           observation.subject_key,
           observation.source_value,
           observation.context,
           observation.evidence
         FROM source_reference_observations observation
         JOIN reference_types type ON type.id = observation.reference_type_id
         JOIN source_products product ON product.id = observation.source_product_id
         LEFT JOIN internal_products internal ON internal.source_product_id = product.id
         WHERE observation.active = TRUE
           AND observation.mapping_id IS NULL
           AND observation.status <> 'ignored'
           AND observation.source_id = $1
           AND type.code = $2
         ORDER BY observation.id`,
        [sourceId, typeCode],
      );

      return result.rows.map((row) => {
        const subjectKind = String(row.subject_kind) as ReferenceCandidateDTO["subjectKind"];
        const subjectKey = String(row.subject_key);
        return {
          observationId: String(row.observation_id),
          sourceId: String(row.source_id),
          sourceProductId: String(row.source_product_id),
          sourceKey: String(row.source_key),
          title: nullableText(row.title),
          sku: nullableText(row.sku),
          candidate: {
            key: String(row.candidate_key),
            typeCode: String(row.type_code),
            scope: String(row.scope),
            subjectKind,
            ...(subjectKind === "variant" ? { subjectKey } : {}),
            sourceValue: String(row.source_value),
            context: jsonObject(row.context),
            evidence: jsonObject(row.evidence),
          },
        };
      });
    });
  }

  async getDecisionContext(key: ClassificationDecisionKey): Promise<ClassificationDecisionContext | null> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `SELECT observation.id, source.code AS source_code, observation.source_value
         FROM source_reference_observations observation
         JOIN sources source ON source.id = observation.source_id
         JOIN reference_types type ON type.id = observation.reference_type_id
         WHERE observation.active = TRUE
           AND observation.source_id = $1
           AND type.code = $2
           AND observation.scope = $3
           AND observation.normalized_source_value = $4
           AND observation.context_key = $5
         ORDER BY observation.last_seen_at DESC, observation.id
         LIMIT 1`,
        [key.sourceId, key.typeCode, key.scope, key.normalizedSourceValue, key.contextKey],
      );
      const row = result.rows[0];
      return row === undefined ? null : {
        ...key,
        observationId: String(row.id),
        sourceCode: String(row.source_code),
        sourceValue: String(row.source_value),
      };
    });
  }

  async saveDecision(input: SaveClassificationDecisionInput): Promise<SaveClassificationDecisionResult> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const observationResult = await client.query<DatabaseRow>(
          `SELECT observation.*, type.id AS type_id
           FROM source_reference_observations observation
           JOIN reference_types type ON type.id = observation.reference_type_id
           WHERE observation.active = TRUE
             AND observation.source_id = $1
             AND type.code = $2
             AND observation.scope = $3
             AND observation.normalized_source_value = $4
             AND observation.context_key = $5
           ORDER BY observation.last_seen_at DESC, observation.id
           LIMIT 1
           FOR UPDATE OF observation`,
          [input.sourceId, input.typeCode, input.scope, input.normalizedSourceValue, input.contextKey],
        );
        const observation = observationResult.rows[0];
        if (observation === undefined) {
          throw new EntityNotFoundError("Classification observation", `${input.sourceId}/${input.typeCode}/${input.normalizedSourceValue}`);
        }

        let referenceValueId = input.referenceValueId ?? null;
        let dictionary: DatabaseRow | undefined;
        if (input.targetLink !== undefined) {
          const dictionaryResult = await client.query<DatabaseRow>(
            `SELECT * FROM target_dictionary_values
             WHERE id = $1 AND target_id = $2 AND active = TRUE
             FOR SHARE`,
            [input.targetLink.dictionaryValueId, input.targetLink.targetId],
          );
          dictionary = dictionaryResult.rows[0];
          if (dictionary === undefined) {
            throw new EntityNotFoundError("Target dictionary value", input.targetLink.dictionaryValueId);
          }

          if (referenceValueId === null) {
            const linkedReferences = await client.query<DatabaseRow>(
              `SELECT mapping.reference_value_id
               FROM target_value_mappings mapping
               JOIN reference_values value
                 ON value.id = mapping.reference_value_id
                AND value.type_id = $4
                AND value.enabled = TRUE
               WHERE mapping.target_id = $1
                 AND mapping.target_scope = $2
                 AND mapping.dictionary_value_id = $3
                 AND mapping.active = TRUE
               FOR SHARE OF mapping`,
              [input.targetLink.targetId, input.targetLink.targetScope, input.targetLink.dictionaryValueId, observation.type_id],
            );
            if (linkedReferences.rows.length > 1) {
              throw new IntegrationContractError("The target dictionary term is linked to more than one internal value");
            }
            if (linkedReferences.rows[0] !== undefined) {
              referenceValueId = String(linkedReferences.rows[0].reference_value_id);
            } else {
              if (input.generatedReferenceCode === undefined) {
                throw new IntegrationContractError("A generated reference code is required for a new internal value");
              }
              const createdReference = await client.query<DatabaseRow>(
                `INSERT INTO reference_values (type_id, code, name, metadata)
                 VALUES ($1, $2, $3, $4::JSONB)
                 RETURNING id`,
                [observation.type_id, input.generatedReferenceCode, dictionary.name, JSON.stringify({
                  origin: "target_dictionary",
                  targetId: input.targetLink.targetId,
                  dictionaryValueId: input.targetLink.dictionaryValueId,
                })],
              );
              referenceValueId = String(createdReference.rows[0]!.id);
            }
          }
        }

        if (input.action === "confirm" && referenceValueId === null) {
          throw new IntegrationContractError("Confirmed classification decision requires a reference value");
        }
        if (input.action === "ignore" && (referenceValueId !== null || input.targetLink !== undefined)) {
          throw new IntegrationContractError("Ignored classification decision cannot contain a reference value or target link");
        }

        if (referenceValueId !== null) {
          const referenceResult = await client.query<DatabaseRow>(
            `SELECT value.id
             FROM reference_values value
             WHERE value.id = $1 AND value.type_id = $2 AND value.enabled = TRUE`,
            [referenceValueId, observation.type_id],
          );
          if (referenceResult.rows[0] === undefined) {
            throw new EntityNotFoundError("Reference value", referenceValueId);
          }
        }

        const targetLinkChanged = input.targetLink !== undefined && dictionary !== undefined && referenceValueId !== null
          ? await this.saveTargetLink(client, input, referenceValueId, dictionary)
          : false;

        const previousResult = await client.query<DatabaseRow>(
          `SELECT * FROM source_reference_mappings
           WHERE source_id = $1
             AND reference_type_id = $2
             AND scope = $3
             AND normalized_source_value = $4
             AND context_key = $5
           FOR UPDATE`,
          [input.sourceId, observation.type_id, input.scope, input.normalizedSourceValue, input.contextKey],
        );
        const previous = previousResult.rows[0];
        const nextStatus = input.action === "confirm" ? "confirmed" : "ignored";
        const unchanged = previous !== undefined
          && String(previous.status) === nextStatus
          && nullableText(previous.reference_value_id) === referenceValueId;

        const mappingResult = await client.query<DatabaseRow>(
          `INSERT INTO source_reference_mappings (
             source_id, reference_type_id, scope, source_value,
             normalized_source_value, context, context_key, reference_value_id,
             status, method, revision, decided_by, decided_at, decision_reason
           ) VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7, $8, $9, 'manual', 1, $10, NOW(), $11)
           ON CONFLICT (source_id, reference_type_id, scope, normalized_source_value, context_key)
           DO UPDATE SET
             source_value = EXCLUDED.source_value,
             context = EXCLUDED.context,
             reference_value_id = EXCLUDED.reference_value_id,
             status = EXCLUDED.status,
             method = EXCLUDED.method,
             revision = CASE
               WHEN source_reference_mappings.status = EXCLUDED.status
                AND source_reference_mappings.reference_value_id IS NOT DISTINCT FROM EXCLUDED.reference_value_id
               THEN source_reference_mappings.revision
               ELSE source_reference_mappings.revision + 1
             END,
             decided_by = EXCLUDED.decided_by,
             decided_at = EXCLUDED.decided_at,
             decision_reason = EXCLUDED.decision_reason,
             updated_at = NOW()
           RETURNING *`,
          [
            input.sourceId,
            observation.type_id,
            input.scope,
            observation.source_value,
            input.normalizedSourceValue,
            JSON.stringify(jsonObject(observation.context)),
            input.contextKey,
            referenceValueId,
            nextStatus,
            input.actor,
            input.reason ?? null,
          ],
        );
        const mapping = mappingResult.rows[0]!;

        if (!unchanged) {
          await client.query(
            `INSERT INTO source_reference_decision_history (
               mapping_id, action, previous_value, new_value, actor, reason
             ) VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`,
            [
              mapping.id,
              input.action,
              previous === undefined ? null : JSON.stringify(previous),
              JSON.stringify(mapping),
              input.actor,
              input.reason ?? null,
            ],
          );
        }

        const affectedResult = await client.query<DatabaseRow>(
          `SELECT DISTINCT observation.source_product_id
           FROM source_reference_observations observation
           WHERE observation.active = TRUE
             AND observation.source_id = $1
             AND observation.reference_type_id = $2
             AND observation.scope = $3
             AND observation.normalized_source_value = $4
             AND observation.context_key = $5`,
          [input.sourceId, observation.type_id, input.scope, input.normalizedSourceValue, input.contextKey],
        );
        const affectedIds = affectedResult.rows.map((row) => String(row.source_product_id));
        const affectedProductCount = unchanged ? 0 : await enqueueProducts(client, affectedIds);
        const affectedExportCount = targetLinkChanged && input.targetLink !== undefined && referenceValueId !== null
          ? await enqueueTargetExports(client, input.targetLink.targetId, referenceValueId)
          : 0;

        await client.query("COMMIT");
        return {
          mappingId: String(mapping.id),
          referenceValueId,
          revision: String(mapping.revision),
          affectedProductCount,
          affectedExportCount,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async createRule(input: CreateClassificationRuleInput): Promise<CreateClassificationRuleResult> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const referenceResult = await client.query<DatabaseRow>(
          `SELECT type.id AS type_id
           FROM reference_types type
           JOIN reference_values value ON value.type_id = type.id
           WHERE type.code = $1 AND type.enabled = TRUE
             AND value.id = $2 AND value.enabled = TRUE`,
          [input.typeCode, input.referenceValueId],
        );
        const reference = referenceResult.rows[0];
        if (reference === undefined) throw new EntityNotFoundError("Reference value", input.referenceValueId);

        const ruleResult = await client.query<DatabaseRow>(
          `INSERT INTO source_reference_rules (
             source_id, reference_type_id, name, priority, conditions,
             reference_value_id, enabled, revision, created_by, updated_by
           ) VALUES ($1, $2, $3, $4, $5::JSONB, $6, TRUE, 1, $7, $7)
           RETURNING *`,
          [input.sourceId, reference.type_id, input.name, input.priority, JSON.stringify(input.conditions), input.referenceValueId, input.actor],
        );
        const rule = ruleResult.rows[0]!;
        await client.query(
          `INSERT INTO source_reference_decision_history (
             rule_id, action, new_value, actor, reason
           ) VALUES ($1, 'create', $2::JSONB, $3, $4)`,
          [rule.id, JSON.stringify(rule), input.actor, input.reason ?? null],
        );
        const affectedProductCount = await enqueueProducts(client, input.affectedSourceProductIds);
        await client.query("COMMIT");
        return {
          ruleId: String(rule.id),
          revision: String(rule.revision),
          affectedProductCount,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  private async saveTargetLink(
    client: SqlClient,
    input: SaveClassificationDecisionInput,
    referenceValueId: string,
    dictionary: DatabaseRow,
  ): Promise<boolean> {
    const targetLink = input.targetLink!;
    const previousResult = await client.query<DatabaseRow>(
      `SELECT * FROM target_value_mappings
       WHERE target_id = $1 AND reference_value_id = $2 AND target_scope = $3
       FOR UPDATE`,
      [targetLink.targetId, referenceValueId, targetLink.targetScope],
    );
    const previous = previousResult.rows[0];
    const mappingResult = await client.query<DatabaseRow>(
      `INSERT INTO target_value_mappings (
         target_id, reference_value_id, target_scope, external_value,
         external_label, metadata, dictionary_value_id, active, revision
       ) VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7, TRUE, 1)
       ON CONFLICT (target_id, reference_value_id, target_scope) DO UPDATE SET
         external_value = EXCLUDED.external_value,
         external_label = EXCLUDED.external_label,
         metadata = EXCLUDED.metadata,
         dictionary_value_id = EXCLUDED.dictionary_value_id,
         active = TRUE,
         revision = CASE
           WHEN target_value_mappings.dictionary_value_id IS NOT DISTINCT FROM EXCLUDED.dictionary_value_id
           THEN target_value_mappings.revision
           ELSE target_value_mappings.revision + 1
         END,
         updated_at = NOW()
       RETURNING *`,
      [
        targetLink.targetId,
        referenceValueId,
        targetLink.targetScope,
        String(dictionary.external_id),
        String(dictionary.name),
        JSON.stringify({
          entityType: String(dictionary.entity_type),
          slug: nullableText(dictionary.slug),
          taxonomy: nullableText(dictionary.taxonomy),
          attributeCode: nullableText(dictionary.attribute_code),
        }),
        targetLink.dictionaryValueId,
      ],
    );
    const mapping = mappingResult.rows[0]!;
    const unchanged = previous !== undefined
      && String(previous.dictionary_value_id) === targetLink.dictionaryValueId
      && Boolean(previous.active);
    if (!unchanged) {
      await client.query(
        `INSERT INTO target_value_mapping_history (
           mapping_id, action, previous_value, new_value, actor, reason
         ) VALUES ($1, 'link', $2::JSONB, $3::JSONB, $4, $5)`,
        [
          mapping.id,
          previous === undefined ? null : JSON.stringify(previous),
          JSON.stringify(mapping),
          input.actor,
          input.reason ?? null,
        ],
      );
    }
    return !unchanged;
  }
}
