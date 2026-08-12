import type { JsonObject, ReferenceCandidateDTO } from "../../../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError } from "../../../core/errors/index.js";
import type {
  ClassificationAdminRepository,
  ClassificationConfigListItem,
  ClassificationConfigListQuery,
  ClassificationConfigListResult,
  ClassificationConfigHistoryRecord,
  ClassificationConfigOutput,
  ClassificationDecisionContext,
  ClassificationDecisionPreview,
  ClassificationDecisionKey,
  ClassificationExactMatchItem,
  ClassificationExactMatchQuery,
  ClassificationExactMatchResult,
  ClassificationReferenceValueOption,
  ClassificationReferenceCatalogQuery,
  ClassificationReferenceCatalogResult,
  ClassificationReviewExample,
  ClassificationReviewExamplesQuery,
  ClassificationReviewExamplesResult,
  ClassificationReviewItem,
  ClassificationReviewQuery,
  ClassificationRuleCandidateRecord,
  ClassificationRuleAdminRecord,
  ClassificationRuleConditionRecord,
  ClassificationRuleConditionFieldOption,
  CreateClassificationRuleInput,
  CreateClassificationRuleResult,
  SaveClassificationDecisionInput,
  SaveClassificationDecisionResult,
  TargetClassificationProjectionCommand,
  TargetClassificationProjectionPreview,
  TargetClassificationProjectionRecord,
  TargetReferenceProjectionCommand,
  TargetReferenceProjectionRecord,
  TargetValueMappingAdminRecord,
  TargetValueMappingCommand,
  CreateTargetValueMappingCommand,
  UpdateClassificationRuleInput,
  UpdateClassificationRuleResult,
} from "../../../repositories/index.js";
import type { SqlClient, SqlPool } from "../sql-executor.js";
import { classificationObservationReadModelSql } from "./classification-observation-read-model.js";
import { mapTargetClassificationProjection, mapTargetReferenceProjection, type DatabaseRow } from "./row-mappers.js";

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

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? [item] : []) : [];
}

function ruleConditions(value: unknown): ClassificationConfigListItem["conditions"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const operator = row.operator;
    if (typeof row.field !== "string" || typeof row.value !== "string") return [];
    if (operator !== "equals" && operator !== "contains" && operator !== "all_words" && operator !== "regex") return [];
    return [{ field: row.field, operator, value: row.value }];
  });
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

function configOutputs(value: unknown): readonly ClassificationConfigOutput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = jsonObject(entry);
    if (row.kind !== "target_mapping" && row.kind !== "projection") return [];
    return [{
      kind: row.kind,
      id: String(row.id),
      targetId: String(row.target_id),
      targetCode: String(row.target_code),
      targetScope: String(row.target_scope),
      targetExternalId: String(row.target_external_id),
      targetLabel: String(row.target_label),
      targetTaxonomy: nullableText(row.target_taxonomy),
      status: row.status === "active" ? "active" as const : "inactive" as const,
    }];
  });
}

function processorVersions(value: Readonly<Record<string, string>> | undefined): string {
  return JSON.stringify(value ?? {});
}

function exactMatchItems(value: unknown): readonly ClassificationExactMatchItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = jsonObject(entry);
    const targets = Array.isArray(row.targets) ? row.targets.map((targetEntry) => {
      const target = jsonObject(targetEntry);
      return {
        dictionaryValueId: String(target.dictionaryValueId),
        externalId: String(target.externalId),
        name: String(target.name),
        slug: nullableText(target.slug),
        taxonomy: nullableText(target.taxonomy),
      };
    }) : [];
    return {
      reviewGroupId: String(row.reviewGroupId),
      sourceId: String(row.sourceId),
      sourceCode: String(row.sourceCode),
      sourceName: String(row.sourceName),
      typeCode: String(row.typeCode),
      typeName: String(row.typeName),
      scope: String(row.scope),
      normalizedSourceValue: String(row.normalizedSourceValue),
      contextKey: String(row.contextKey),
      sourceValue: String(row.sourceValue),
      productCount: Number(row.productCount),
      observationCount: Number(row.observationCount),
      targetScope: String(row.targetScope),
      matchStatus: String(row.matchStatus) as ClassificationExactMatchItem["matchStatus"],
      issueReason: nullableText(row.issueReason) as ClassificationExactMatchItem["issueReason"],
      targets,
    };
  });
}

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizedJson(item)]));
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizedJson(left)) === JSON.stringify(normalizedJson(right));
}

function reviewQueueFilter(query: ClassificationReviewQuery): {
  readonly sql: string;
  readonly parameters: unknown[];
} {
  const search = query.search?.trim() ?? "";
  const searchFilter = search.length === 0
    ? "\n  AND $4::TEXT = ''"
    : search.length < 3
      ? "\n  AND LOWER(review.source_value) LIKE LOWER($4::TEXT) || '%'"
      : "\n  AND review.source_value ILIKE '%' || $4::TEXT || '%'";
  return {
    sql: `WHERE ($5::JSONB = '{}'::JSONB
      OR review.processor_version = $5::JSONB ->> review.source_id::TEXT)
    AND ($1::BIGINT IS NULL OR review.source_id = $1)
    AND ($2::TEXT = '' OR review.reference_type_id = (
      SELECT id FROM reference_types WHERE code = $2
    ))
    AND (($3::TEXT = '' AND review.review_status IN ('unresolved', 'ambiguous'))
      OR review.review_status = $3)
    AND ($6::TEXT = '' OR review.context_key = $6)${searchFilter}`,
    parameters: [
      query.sourceId ?? null,
      query.typeCode ?? "",
      query.status ?? "",
      search,
      processorVersions(query.currentProcessorVersions),
      query.contextKey ?? "",
    ],
  };
}

function ruleCandidateFilters(
  conditions: readonly ClassificationRuleConditionRecord[],
  firstParameter: number,
): { readonly sql: string; readonly values: readonly string[] } {
  const clauses: string[] = [];
  const values: string[] = [];
  const parameter = (value: string): string => {
    values.push(value);
    return `$${firstParameter + values.length - 1}`;
  };
  for (const condition of conditions) {
    if (condition.operator === "regex") continue;
    let actual: string;
    if (condition.field === "sourceValue") {
      actual = "observation.normalized_source_value";
    } else if (condition.field === "scope") {
      actual = "LOWER(NORMALIZE(BTRIM(observation.scope), NFKC))";
    } else if (condition.field === "subjectKind") {
      actual = "LOWER(NORMALIZE(BTRIM(observation.subject_kind), NFKC))";
    } else {
      const match = /^(context|evidence)\.([a-zA-Z][a-zA-Z0-9_-]*)$/u.exec(condition.field);
      if (match === null) continue;
      const key = parameter(match[2]!);
      actual = `LOWER(NORMALIZE(BTRIM(COALESCE(observation.${match[1]} ->> ${key}, '')), NFKC))`;
    }
    const normalized = condition.value.trim().normalize("NFKC").toLowerCase();
    if (condition.operator === "equals") {
      clauses.push(`${actual} = ${parameter(normalized)}`);
    } else if (condition.operator === "contains") {
      clauses.push(`${actual} LIKE '%' || ${parameter(normalized)} || '%'`);
    } else {
      for (const word of normalized.split(/\s+/u).filter(Boolean)) {
        clauses.push(`${actual} LIKE '%' || ${parameter(word)} || '%'`);
      }
    }
  }
  return {
    sql: clauses.length === 0 ? "" : `\n           AND ${clauses.join("\n           AND ")}`,
    values,
  };
}

function mapTargetValueMappingAdmin(row: DatabaseRow): TargetValueMappingAdminRecord {
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    referenceValueId: String(row.reference_value_id),
    targetScope: String(row.target_scope),
    externalValue: String(row.external_value),
    externalLabel: String(row.external_label),
    metadata: jsonObject(row.metadata),
    dictionaryValueId: nullableText(row.dictionary_value_id),
    active: row.active === true,
    revision: String(row.revision),
    typeCode: String(row.type_code),
  };
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
  await client.query(
    `INSERT INTO jobs (job_type, payload, status, available_at, unique_key)
     SELECT
       'reclassify_product',
       JSONB_BUILD_OBJECT('sourceProductId', product_id::TEXT),
       'pending',
       NOW(),
       'source-product:' || product_id::TEXT || ':process'
     FROM UNNEST($1::BIGINT[]) AS product_id
     WHERE NOT EXISTS (
       SELECT 1
       FROM jobs active_job
       WHERE active_job.job_type IN ('process_product', 'reclassify_product')
         AND active_job.unique_key = 'source-product:' || product_id::TEXT || ':process'
         AND active_job.status IN ('pending', 'running', 'retry')
     )
     ON CONFLICT (job_type, unique_key)
       WHERE status IN ('pending', 'running', 'retry')
     DO NOTHING`,
    [uniqueIds],
  );
  return uniqueIds.length;
}

async function enqueueDecisionProducts(
  client: SqlClient,
  candidateId: string,
  sharedReferenceValueId: string | null,
): Promise<number> {
  const result = await client.query<DatabaseRow>(
    `WITH affected AS MATERIALIZED (
       SELECT link.source_product_id AS product_id
       FROM source_product_classification_links link
       WHERE link.candidate_id = $1
         AND link.active = TRUE
       UNION
       SELECT link.source_product_id AS product_id
       FROM source_product_classification_links link
       WHERE $2::BIGINT IS NOT NULL
         AND link.resolved_reference_value_id = $2
         AND link.active = TRUE
     ), enqueued AS (
       INSERT INTO jobs (job_type, payload, status, available_at, unique_key)
       SELECT
         'reclassify_product',
         JSONB_BUILD_OBJECT('sourceProductId', affected.product_id::TEXT),
         'pending',
         NOW(),
         'source-product:' || affected.product_id::TEXT || ':process'
       FROM affected
       WHERE NOT EXISTS (
         SELECT 1
         FROM jobs active_job
         WHERE active_job.job_type IN ('process_product', 'reclassify_product')
           AND active_job.unique_key = 'source-product:' || affected.product_id::TEXT || ':process'
           AND active_job.status IN ('pending', 'running', 'retry')
       )
       ON CONFLICT (job_type, unique_key)
         WHERE status IN ('pending', 'running', 'retry')
       DO NOTHING
       RETURNING id
     )
     SELECT COUNT(*)::INTEGER AS affected_product_count,
            (SELECT COUNT(*) FROM enqueued) AS enqueued_job_count
     FROM affected`,
    [candidateId, sharedReferenceValueId],
  );
  return Number(result.rows[0]?.affected_product_count ?? 0);
}

function reviewGroupKey(row: DatabaseRow) {
  return {
    source_id: String(row.source_id),
    type_code: String(row.type_code),
    processor_version: String(row.processor_version),
    scope: String(row.scope),
    normalized_source_value: String(row.normalized_source_value),
    context_key: String(row.context_key),
    observation_status: String(row.observation_status),
  };
}

async function refreshReviewGroups(
  client: SqlClient,
  keys: readonly ReturnType<typeof reviewGroupKey>[],
): Promise<void> {
  if (keys.length === 0) return;
  await client.query("SELECT refresh_classification_review_groups($1::JSONB)", [JSON.stringify(keys)]);
}

async function replaceRuleReviewCoverage(
  client: SqlClient,
  ruleId: string,
  ruleRevision: string,
  matchedObservationIds: readonly string[],
): Promise<readonly string[]> {
  const previous = await client.query<DatabaseRow>(
    `SELECT observation.id, observation.source_id, type.code AS type_code, observation.processor_version,
            observation.scope, observation.normalized_source_value, observation.context_key,
            observation.status AS observation_status
     FROM classification_review_rule_coverage coverage
     JOIN ${classificationObservationReadModelSql} observation ON observation.id = coverage.observation_id
     JOIN reference_types type ON type.id = observation.reference_type_id
     WHERE coverage.rule_id = $1
       AND observation.active = TRUE
       AND observation.status IN ('unresolved', 'ambiguous')`,
    [ruleId],
  );
  await client.query("DELETE FROM classification_review_rule_coverage WHERE rule_id = $1", [ruleId]);
  if (matchedObservationIds.length > 0) {
    await client.query(
      `INSERT INTO classification_review_rule_coverage (
         observation_id, rule_id, rule_revision
       )
       SELECT observation.id, $1, $2
       FROM ${classificationObservationReadModelSql} observation
       WHERE observation.id = ANY($3::BIGINT[])
         AND observation.active = TRUE
         AND observation.status IN ('unresolved', 'ambiguous')
       ON CONFLICT (observation_id, rule_id) DO UPDATE SET
          rule_revision = EXCLUDED.rule_revision,
          updated_at = NOW()`,
      [ruleId, ruleRevision, matchedObservationIds],
    );
  }
  const current = await client.query<DatabaseRow>(
    `SELECT observation.source_product_id, observation.source_id, type.code AS type_code,
            observation.processor_version, observation.scope, observation.normalized_source_value,
            observation.context_key, observation.status AS observation_status
     FROM classification_review_rule_coverage coverage
     JOIN ${classificationObservationReadModelSql} observation ON observation.id = coverage.observation_id
     JOIN reference_types type ON type.id = observation.reference_type_id
     WHERE coverage.rule_id = $1
       AND observation.active = TRUE
       AND observation.status IN ('unresolved', 'ambiguous')`,
    [ruleId],
  );
  await refreshReviewGroups(client, [
    ...previous.rows.map(reviewGroupKey),
    ...current.rows.map(reviewGroupKey),
  ]);
  return [];
}

async function markDecisionReviewGroupsWaiting(
  client: SqlClient,
  key: ClassificationDecisionKey,
  referenceTypeId: string,
): Promise<void> {
  await client.query(
    `UPDATE classification_review_groups review
     SET review_status = 'waiting_apply',
         needs_decision_observation_count = 0,
         needs_decision_product_count = 0,
         waiting_observation_count = review.total_observation_count,
         waiting_product_count = review.total_product_count,
         updated_at = NOW()
     WHERE review.source_id = $1
       AND review.reference_type_id = $2
       AND review.scope = $3
       AND review.normalized_source_value = $4
       AND review.context_key = $5
       AND review.observation_status IN ('unresolved', 'ambiguous')`,
    [key.sourceId, referenceTypeId, key.scope, key.normalizedSourceValue, key.contextKey],
  );
}

export class PostgresClassificationAdminRepository implements ClassificationAdminRepository {
  constructor(private readonly pool: SqlPool) {}

  async listConfiguration(query: ClassificationConfigListQuery): Promise<ClassificationConfigListResult> {
    return withClient(this.pool, async (client) => {
      const parameters: unknown[] = [];
      const add = (value: unknown): string => {
        parameters.push(value);
        return `$${parameters.length}`;
      };
      const filters = {
        kind: query.kind ?? "",
        configId: query.configId ?? null,
        referenceValueId: query.referenceValueId ?? null,
        sourceId: query.sourceId ?? null,
        targetId: query.targetId ?? null,
        typeCode: query.typeCode ?? "",
        status: query.status ?? "",
        search: query.search?.trim() ?? "",
      };
      const kind = add(filters.kind);
      const configId = add(filters.configId);
      const referenceValueId = add(filters.referenceValueId);
      const sourceId = add(filters.sourceId);
      const targetId = add(filters.targetId);
      const typeCode = add(filters.typeCode);
      const status = add(filters.status);
      const search = add(filters.search);
      const union = `
        SELECT 'mapping' AS kind, mapping.id, mapping.source_id, source.code AS source_code,
               NULL::BIGINT AS target_id, NULL::TEXT AS target_code, type.code AS type_code, type.name AS type_name,
               mapping.scope, mapping.source_value, mapping.normalized_source_value, mapping.context, mapping.context_key,
               mapping.reference_value_id, value.name AS reference_name, NULL::TEXT AS target_scope,
               NULL::TEXT AS target_external_id, NULL::TEXT AS target_label, NULL::TEXT AS target_taxonomy, NULL::BIGINT AS target_dictionary_value_id,
               NULL::TEXT AS rule_name, '[]'::JSONB AS conditions, NULL::INTEGER AS priority,
               CASE WHEN mapping.status = 'ignored' THEN 'ignored' ELSE 'active' END AS status,
               mapping.revision, mapping.decided_by AS actor, mapping.decision_reason AS reason,
               mapping.created_at, mapping.updated_at, 'mapping'::TEXT AS resolution_kind, mapping.id AS resolution_id
        FROM source_reference_mappings mapping
        JOIN sources source ON source.id = mapping.source_id
        JOIN reference_types type ON type.id = mapping.reference_type_id
        LEFT JOIN reference_values value ON value.id = mapping.reference_value_id
        UNION ALL
        SELECT 'rule' AS kind, rule.id, rule.source_id, source.code AS source_code,
               NULL::BIGINT AS target_id, NULL::TEXT AS target_code, type.code AS type_code, type.name AS type_name,
               NULL::TEXT AS scope, NULL::TEXT AS source_value, NULL::TEXT AS normalized_source_value,
               '{}'::JSONB AS context, NULL::TEXT AS context_key, rule.reference_value_id, value.name AS reference_name,
               NULL::TEXT AS target_scope, NULL::TEXT AS target_external_id, NULL::TEXT AS target_label, NULL::TEXT AS target_taxonomy, NULL::BIGINT AS target_dictionary_value_id,
               rule.name AS rule_name, rule.conditions, rule.priority,
               CASE WHEN rule.enabled THEN 'active' ELSE 'inactive' END AS status,
               rule.revision, rule.updated_by AS actor, NULL::TEXT AS reason, rule.created_at, rule.updated_at,
               'rule'::TEXT AS resolution_kind, rule.id AS resolution_id
        FROM source_reference_rules rule
        JOIN sources source ON source.id = rule.source_id
        JOIN reference_types type ON type.id = rule.reference_type_id
        JOIN reference_values value ON value.id = rule.reference_value_id
        WHERE rule.deleted_at IS NULL
        UNION ALL
        SELECT 'target_mapping' AS kind, mapping.id, NULL::BIGINT AS source_id, NULL::TEXT AS source_code,
               mapping.target_id, target.code AS target_code, type.code AS type_code, type.name AS type_name,
               NULL::TEXT AS scope, NULL::TEXT AS source_value, NULL::TEXT AS normalized_source_value,
               '{}'::JSONB AS context, NULL::TEXT AS context_key, mapping.reference_value_id, value.name AS reference_name,
               mapping.target_scope, mapping.external_value AS target_external_id, mapping.external_label AS target_label,
               dictionary.taxonomy AS target_taxonomy, dictionary.id AS target_dictionary_value_id, NULL::TEXT AS rule_name, '[]'::JSONB AS conditions,
               NULL::INTEGER AS priority, CASE WHEN mapping.active THEN 'active' ELSE 'inactive' END AS status,
               mapping.revision, NULL::TEXT AS actor, NULL::TEXT AS reason, mapping.created_at, mapping.updated_at,
               NULL::TEXT AS resolution_kind, NULL::BIGINT AS resolution_id
        FROM target_value_mappings mapping
        JOIN targets target ON target.id = mapping.target_id
        JOIN reference_values value ON value.id = mapping.reference_value_id
        JOIN reference_types type ON type.id = value.type_id
        LEFT JOIN target_dictionary_values dictionary ON dictionary.id = mapping.dictionary_value_id
        UNION ALL
        SELECT 'projection' AS kind, projection.id,
               COALESCE(mapping.source_id, rule.source_id) AS source_id, source.code AS source_code,
               projection.target_id, target.code AS target_code, type.code AS type_code, type.name AS type_name,
               mapping.scope, mapping.source_value, mapping.normalized_source_value, COALESCE(mapping.context, '{}'::JSONB) AS context,
               mapping.context_key, COALESCE(mapping.reference_value_id, rule.reference_value_id) AS reference_value_id,
               value.name AS reference_name, projection.target_scope, dictionary.external_id AS target_external_id,
               dictionary.name AS target_label, dictionary.taxonomy AS target_taxonomy, dictionary.id AS target_dictionary_value_id,
               rule.name AS rule_name, COALESCE(rule.conditions, '[]'::JSONB) AS conditions, rule.priority,
               CASE WHEN projection.active THEN 'active' ELSE 'inactive' END AS status,
               projection.revision, projection.created_by AS actor, NULL::TEXT AS reason,
               projection.created_at, projection.updated_at,
               CASE WHEN projection.mapping_id IS NULL THEN 'rule' ELSE 'mapping' END AS resolution_kind,
               COALESCE(projection.mapping_id, projection.rule_id) AS resolution_id
        FROM target_classification_projections projection
        JOIN targets target ON target.id = projection.target_id
        LEFT JOIN source_reference_mappings mapping ON mapping.id = projection.mapping_id
        LEFT JOIN source_reference_rules rule ON rule.id = projection.rule_id
        LEFT JOIN sources source ON source.id = COALESCE(mapping.source_id, rule.source_id)
        JOIN reference_values value ON value.id = COALESCE(mapping.reference_value_id, rule.reference_value_id)
        JOIN reference_types type ON type.id = value.type_id
        JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
        WHERE projection.rule_id IS NULL OR rule.deleted_at IS NULL`;
      const filtered = `FROM (${union}) item
        WHERE (${kind}::TEXT = '' OR item.kind = ${kind})
          AND (${configId}::BIGINT IS NULL OR item.id = ${configId})
          AND (${referenceValueId}::BIGINT IS NULL OR item.reference_value_id = ${referenceValueId})
          AND (${sourceId}::BIGINT IS NULL OR item.source_id = ${sourceId})
          AND (${targetId}::BIGINT IS NULL OR item.target_id = ${targetId})
          AND (${typeCode}::TEXT = '' OR item.type_code = ${typeCode})
          AND (${status}::TEXT = '' OR item.status = ${status})
          AND (${search}::TEXT = '' OR item.source_value ILIKE '%' || ${search} || '%'
            OR item.normalized_source_value ILIKE '%' || ${search} || '%'
            OR item.reference_name ILIKE '%' || ${search} || '%'
            OR item.target_label ILIKE '%' || ${search} || '%'
            OR item.rule_name ILIKE '%' || ${search} || '%'
            OR item.context::TEXT ILIKE '%' || ${search} || '%')`;
      const count = await client.query<DatabaseRow>(`SELECT COUNT(*) AS total ${filtered}`, parameters);
      const versions = add(processorVersions(query.currentProcessorVersions));
      const includeUsage = add(query.includeUsage !== false);
      const limit = add(query.limit);
      const offset = add(query.offset);
      const result = await client.query<DatabaseRow>(
        `WITH page_items AS MATERIALIZED (
           SELECT item.*
           ${filtered}
           ORDER BY item.updated_at DESC, item.kind, item.id DESC
           LIMIT ${limit} OFFSET ${offset}
         ), product_states AS MATERIALIZED (
           SELECT state.source_product_id, state.processor_version
           FROM source_product_classification_states state
         ), observation_stats AS MATERIALIZED (
           SELECT item.kind, item.id AS config_id,
                  COUNT(DISTINCT observation.source_product_id)::INTEGER AS affected_product_count
           FROM page_items item
           JOIN source_product_classification_links observation ON observation.mapping_id = item.id
           JOIN product_states state ON state.source_product_id = observation.source_product_id
           WHERE ${includeUsage}::BOOLEAN AND item.kind = 'mapping'
             AND observation.active = TRUE
             AND (${versions}::JSONB = '{}'::JSONB
                OR state.processor_version = ${versions}::JSONB ->> item.source_id::TEXT)
           GROUP BY item.kind, item.id
           UNION ALL
           SELECT item.kind, item.id, COUNT(DISTINCT observation.source_product_id)::INTEGER
           FROM page_items item
           JOIN source_product_classification_links observation ON observation.rule_id = item.id
           JOIN product_states state ON state.source_product_id = observation.source_product_id
           JOIN classification_candidates candidate ON candidate.id = observation.candidate_id
           WHERE ${includeUsage}::BOOLEAN AND item.kind = 'rule'
             AND observation.active = TRUE
             AND (${versions}::JSONB = '{}'::JSONB
                OR state.processor_version = ${versions}::JSONB ->> candidate.source_id::TEXT)
           GROUP BY item.kind, item.id
           UNION ALL
           SELECT item.kind, item.id, COUNT(DISTINCT observation.source_product_id)::INTEGER
           FROM page_items item
           JOIN source_product_classification_links observation
             ON observation.resolved_reference_value_id = item.reference_value_id
           JOIN product_states state ON state.source_product_id = observation.source_product_id
           JOIN source_products product ON product.id = observation.source_product_id
           WHERE ${includeUsage}::BOOLEAN AND item.kind = 'target_mapping'
             AND observation.active = TRUE
             AND (${versions}::JSONB = '{}'::JSONB
                OR state.processor_version = ${versions}::JSONB ->> product.source_id::TEXT)
           GROUP BY item.kind, item.id
           UNION ALL
           SELECT item.kind, item.id, COUNT(DISTINCT observation.source_product_id)::INTEGER
           FROM page_items item
           JOIN source_product_classification_links observation ON observation.mapping_id = item.resolution_id
           JOIN product_states state ON state.source_product_id = observation.source_product_id
           WHERE ${includeUsage}::BOOLEAN AND item.kind = 'projection'
             AND item.resolution_kind = 'mapping'
             AND observation.active = TRUE
             AND (${versions}::JSONB = '{}'::JSONB
                OR state.processor_version = ${versions}::JSONB ->> item.source_id::TEXT)
           GROUP BY item.kind, item.id
           UNION ALL
           SELECT item.kind, item.id, COUNT(DISTINCT observation.source_product_id)::INTEGER
           FROM page_items item
           JOIN source_product_classification_links observation ON observation.rule_id = item.resolution_id
           JOIN product_states state ON state.source_product_id = observation.source_product_id
           JOIN classification_candidates candidate ON candidate.id = observation.candidate_id
           WHERE ${includeUsage}::BOOLEAN AND item.kind = 'projection'
             AND item.resolution_kind = 'rule'
             AND observation.active = TRUE
             AND (${versions}::JSONB = '{}'::JSONB
                OR state.processor_version = ${versions}::JSONB ->> candidate.source_id::TEXT)
           GROUP BY item.kind, item.id
         ), example_observations AS MATERIALIZED (
           SELECT item.kind, item.id AS config_id, example.*
           FROM page_items item
           JOIN LATERAL (
             SELECT observation.id AS observation_id, observation.source_product_id, observation.last_seen_at
             FROM source_product_classification_links observation
             JOIN source_product_classification_states state ON state.source_product_id = observation.source_product_id
             JOIN classification_candidates candidate ON candidate.id = observation.candidate_id
             WHERE observation.mapping_id = item.id
               AND observation.active = TRUE
               AND (${versions}::JSONB = '{}'::JSONB
                  OR state.processor_version = ${versions}::JSONB ->> candidate.source_id::TEXT)
             ORDER BY observation.last_seen_at DESC, observation.id DESC
             LIMIT 5
           ) example ON TRUE
           WHERE ${includeUsage}::BOOLEAN AND item.kind = 'mapping'
           UNION ALL
           SELECT item.kind, item.id, example.*
           FROM page_items item
           JOIN LATERAL (
             SELECT observation.id, observation.source_product_id, observation.last_seen_at
             FROM source_product_classification_links observation
             JOIN source_product_classification_states state ON state.source_product_id = observation.source_product_id
             JOIN classification_candidates candidate ON candidate.id = observation.candidate_id
             WHERE observation.rule_id = item.id
               AND observation.active = TRUE
               AND (${versions}::JSONB = '{}'::JSONB
                  OR state.processor_version = ${versions}::JSONB ->> candidate.source_id::TEXT)
             ORDER BY observation.last_seen_at DESC, observation.id DESC
             LIMIT 5
           ) example ON TRUE
           WHERE ${includeUsage}::BOOLEAN AND item.kind = 'rule'
           UNION ALL
           SELECT item.kind, item.id, example.*
           FROM page_items item
           JOIN LATERAL (
             SELECT observation.id, observation.source_product_id, observation.last_seen_at
             FROM source_product_classification_links observation
             JOIN source_product_classification_states state ON state.source_product_id = observation.source_product_id
             JOIN source_products product ON product.id = observation.source_product_id
             WHERE observation.resolved_reference_value_id = item.reference_value_id
               AND observation.active = TRUE
               AND (${versions}::JSONB = '{}'::JSONB
                  OR state.processor_version = ${versions}::JSONB ->> product.source_id::TEXT)
             ORDER BY observation.last_seen_at DESC, observation.id DESC
             LIMIT 5
           ) example ON TRUE
           WHERE ${includeUsage}::BOOLEAN AND item.kind = 'target_mapping'
           UNION ALL
           SELECT item.kind, item.id, example.*
           FROM page_items item
           JOIN LATERAL (
             SELECT observation.id, observation.source_product_id, observation.last_seen_at
             FROM source_product_classification_links observation
             JOIN source_product_classification_states state ON state.source_product_id = observation.source_product_id
             WHERE observation.mapping_id = item.resolution_id
               AND observation.active = TRUE
               AND (${versions}::JSONB = '{}'::JSONB
                  OR state.processor_version = ${versions}::JSONB ->> item.source_id::TEXT)
             ORDER BY observation.last_seen_at DESC, observation.id DESC
             LIMIT 5
           ) example ON TRUE
           WHERE ${includeUsage}::BOOLEAN AND item.kind = 'projection' AND item.resolution_kind = 'mapping'
           UNION ALL
           SELECT item.kind, item.id, example.*
           FROM page_items item
           JOIN LATERAL (
             SELECT observation.id, observation.source_product_id, observation.last_seen_at
             FROM source_product_classification_links observation
             JOIN source_product_classification_states state ON state.source_product_id = observation.source_product_id
             JOIN classification_candidates candidate ON candidate.id = observation.candidate_id
             WHERE observation.rule_id = item.resolution_id
               AND observation.active = TRUE
               AND (${versions}::JSONB = '{}'::JSONB
                  OR state.processor_version = ${versions}::JSONB ->> candidate.source_id::TEXT)
             ORDER BY observation.last_seen_at DESC, observation.id DESC
             LIMIT 5
           ) example ON TRUE
           WHERE ${includeUsage}::BOOLEAN AND item.kind = 'projection' AND item.resolution_kind = 'rule'
         ), observation_examples AS MATERIALIZED (
           SELECT example.kind, example.config_id,
                  JSONB_AGG(JSONB_BUILD_OBJECT(
                    'observation_id', example.observation_id,
                    'source_product_id', example.source_product_id,
                    'source_key', product.source_key,
                    'title', internal.data->>'title',
                    'sku', internal.data->>'sku',
                    'evidence', evidence.evidence,
                    'target_snapshots', '[]'::JSONB
                  ) ORDER BY example.last_seen_at DESC, example.observation_id DESC) AS examples
           FROM example_observations example
           JOIN source_product_classification_links observation ON observation.id = example.observation_id
           JOIN source_product_classification_evidence evidence ON evidence.id = observation.evidence_id
           JOIN source_products product ON product.id = example.source_product_id
           JOIN internal_products internal ON internal.source_product_id = example.source_product_id
           GROUP BY example.kind, example.config_id
         )
         SELECT page_items.*,
           COALESCE(observation_stats.affected_product_count, 0) AS affected_product_count,
           COALESCE(observation_examples.examples, '[]'::JSONB) AS examples,
           COALESCE((
               SELECT JSONB_AGG(TO_JSONB(output) ORDER BY output.kind, output.target_scope, output.target_label)
               FROM (
                 SELECT 'target_mapping'::TEXT AS kind, target_mapping.id,
                        target_mapping.target_id, target.code AS target_code,
                        target_mapping.target_scope,
                        target_mapping.external_value AS target_external_id,
                        target_mapping.external_label AS target_label,
                        dictionary.taxonomy AS target_taxonomy,
                        CASE WHEN target_mapping.active THEN 'active' ELSE 'inactive' END AS status
                 FROM target_value_mappings target_mapping
                 JOIN targets target ON target.id = target_mapping.target_id
                 LEFT JOIN target_dictionary_values dictionary ON dictionary.id = target_mapping.dictionary_value_id
                 WHERE page_items.kind IN ('mapping', 'rule')
                   AND target_mapping.reference_value_id = page_items.reference_value_id
                 UNION ALL
                 SELECT 'projection'::TEXT AS kind, projection.id,
                        projection.target_id, target.code AS target_code,
                        projection.target_scope,
                        dictionary.external_id AS target_external_id,
                        dictionary.name AS target_label,
                        dictionary.taxonomy AS target_taxonomy,
                        CASE WHEN projection.active THEN 'active' ELSE 'inactive' END AS status
                 FROM target_classification_projections projection
                 JOIN targets target ON target.id = projection.target_id
                 JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
                 WHERE page_items.kind IN ('mapping', 'rule')
                   AND ((page_items.kind = 'mapping' AND projection.mapping_id = page_items.id)
                     OR (page_items.kind = 'rule' AND projection.rule_id = page_items.id))
               ) output
             ), '[]'::JSONB) AS outputs
         FROM page_items
         LEFT JOIN observation_stats
           ON observation_stats.kind = page_items.kind
          AND observation_stats.config_id = page_items.id
         LEFT JOIN observation_examples
           ON observation_examples.kind = page_items.kind
          AND observation_examples.config_id = page_items.id
         ORDER BY page_items.updated_at DESC, page_items.kind, page_items.id DESC`,
        parameters,
      );
      const sources = await client.query<DatabaseRow>("SELECT id, code, name FROM sources ORDER BY name, id");
      const targets = await client.query<DatabaseRow>("SELECT id, code, name FROM targets ORDER BY name, id");
      const types = await client.query<DatabaseRow>("SELECT code, name FROM reference_types WHERE enabled = TRUE ORDER BY name, code");
      return {
        total: Number(count.rows[0]?.total ?? 0),
        sources: sources.rows.map((row) => ({ id: String(row.id), code: String(row.code), name: String(row.name) })),
        targets: targets.rows.map((row) => ({ id: String(row.id), code: String(row.code), name: String(row.name) })),
        types: types.rows.map((row) => ({ code: String(row.code), name: String(row.name) })),
        items: result.rows.map((row) => ({
          kind: String(row.kind) as ClassificationConfigListItem["kind"],
          id: String(row.id),
          sourceId: nullableText(row.source_id),
          sourceCode: nullableText(row.source_code),
          targetId: nullableText(row.target_id),
          targetCode: nullableText(row.target_code),
          typeCode: nullableText(row.type_code),
          typeName: nullableText(row.type_name),
          scope: nullableText(row.scope),
          sourceValue: nullableText(row.source_value),
          normalizedSourceValue: nullableText(row.normalized_source_value),
          context: jsonObject(row.context),
          contextKey: nullableText(row.context_key),
          referenceValueId: nullableText(row.reference_value_id),
          referenceName: nullableText(row.reference_name),
          targetScope: nullableText(row.target_scope),
          targetExternalId: nullableText(row.target_external_id),
          targetLabel: nullableText(row.target_label),
          targetTaxonomy: nullableText(row.target_taxonomy),
          targetDictionaryValueId: nullableText(row.target_dictionary_value_id),
          ruleName: nullableText(row.rule_name),
          conditions: ruleConditions(row.conditions),
          priority: row.priority === null || row.priority === undefined ? null : Number(row.priority),
          status: String(row.status) as ClassificationConfigListItem["status"],
          revision: String(row.revision),
          actor: nullableText(row.actor),
          reason: nullableText(row.reason),
          affectedProductCount: Number(row.affected_product_count),
          examples: reviewExamples(row.examples),
          outputs: configOutputs(row.outputs),
          createdAt: timestamp(row.created_at),
          updatedAt: timestamp(row.updated_at),
        })),
      };
    });
  }

  async listReviewQueue(query: ClassificationReviewQuery): Promise<readonly ClassificationReviewItem[]> {
    return withClient(this.pool, async (client) => {
      const filter = reviewQueueFilter(query);
      const result = await client.query<DatabaseRow>(
        `WITH review_page AS MATERIALIZED (
          SELECT review.*,
            CASE WHEN review.review_status = 'waiting_apply'
              THEN review.waiting_observation_count
              ELSE review.needs_decision_observation_count
            END AS observation_count,
            CASE WHEN review.review_status = 'waiting_apply'
              THEN review.waiting_product_count
              ELSE review.needs_decision_product_count
            END AS product_count
          FROM classification_review_groups review
          ${filter.sql}
          ORDER BY product_count DESC, review.last_seen_at DESC, review.normalized_source_value, review.id DESC
          LIMIT $7 OFFSET $8
        )
        SELECT
          review_page.id AS review_group_id,
          review_page.source_id,
          source.code AS source_code,
          source.name AS source_name,
          type.code AS type_code,
          type.name AS type_name,
          review_page.scope,
          review_page.normalized_source_value,
          review_page.context_key,
          review_page.source_value,
          review_page.context,
          review_page.review_status AS status,
          review_page.issue_reason,
          review_page.observation_count,
          review_page.product_count,
          review_page.first_seen_at,
          review_page.last_seen_at,
          '[]'::JSONB AS examples
        FROM review_page
        JOIN sources source ON source.id = review_page.source_id
        JOIN reference_types type ON type.id = review_page.reference_type_id
        ORDER BY product_count DESC, last_seen_at DESC, normalized_source_value, review_group_id DESC`,
        [...filter.parameters, query.limit, query.offset],
      );

      return result.rows.map((row) => ({
        reviewGroupId: String(row.review_group_id),
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

  async countReviewQueue(query: ClassificationReviewQuery): Promise<number> {
    return withClient(this.pool, async (client) => {
      const filter = reviewQueueFilter(query);
      const result = await client.query<DatabaseRow>(
        `SELECT COUNT(*)::INTEGER AS total
         FROM classification_review_groups review
         ${filter.sql}`,
        filter.parameters,
      );
      return Number(result.rows[0]?.total ?? 0);
    });
  }

  async listExactMatches(query: ClassificationExactMatchQuery): Promise<ClassificationExactMatchResult> {
    return withClient(this.pool, async (client) => {
      const capabilities = query.capabilities.map((capability) => ({
        type_code: capability.typeCode,
        entity_type: capability.entityType,
        target_scope: capability.targetScope,
      }));
      const result = await client.query<DatabaseRow>(
        `WITH capability AS MATERIALIZED (
           SELECT item.type_code,
                  item.entity_type,
                  item.target_scope,
                  type.id AS reference_type_id,
                  type.name AS type_name
           FROM JSONB_TO_RECORDSET($2::JSONB) AS item(
             type_code TEXT,
             entity_type TEXT,
             target_scope TEXT
           )
           JOIN reference_types type ON type.code = item.type_code
         ), dictionary_candidates AS MATERIALIZED (
           SELECT capability.*,
                  dictionary.id AS dictionary_value_id,
                  dictionary.external_id,
                  dictionary.name AS target_name,
                  dictionary.slug,
                  dictionary.taxonomy,
                  LOWER(NORMALIZE(BTRIM(dictionary.name), NFKC)) AS normalized_target_name
           FROM capability
           JOIN target_dictionary_values dictionary
             ON dictionary.target_id = $1
            AND dictionary.entity_type = capability.entity_type
            AND dictionary.active = TRUE
         ), dictionary_matches AS MATERIALIZED (
           SELECT review.id AS review_group_id,
                  review.source_id,
                  source.code AS source_code,
                  source.name AS source_name,
                  review.reference_type_id,
                  dictionary.type_code,
                  dictionary.type_name,
                  review.scope,
                  review.normalized_source_value,
                  review.context_key,
                  review.source_value,
                  review.review_status,
                  review.issue_reason,
                  review.needs_decision_observation_count AS observation_count,
                  review.needs_decision_product_count AS product_count,
                  dictionary.target_scope,
                  review.last_seen_at,
                  dictionary.dictionary_value_id,
                  dictionary.external_id,
                  dictionary.target_name,
                  dictionary.slug,
                  dictionary.taxonomy,
                  COUNT(DISTINCT reference.id)::INTEGER AS linked_reference_count
           FROM dictionary_candidates dictionary
           JOIN classification_review_groups review
             ON review.reference_type_id = dictionary.reference_type_id
            AND review.normalized_source_value = dictionary.normalized_target_name
           JOIN sources source ON source.id = review.source_id
           LEFT JOIN target_value_mappings mapping
             ON mapping.target_id = $1
            AND mapping.target_scope = dictionary.target_scope
            AND mapping.dictionary_value_id = dictionary.dictionary_value_id
            AND mapping.active = TRUE
           LEFT JOIN reference_values reference
             ON reference.id = mapping.reference_value_id
            AND reference.type_id = review.reference_type_id
            AND reference.enabled = TRUE
           WHERE review.review_status IN ('unresolved', 'ambiguous')
             AND review.needs_decision_observation_count > 0
             AND ($3::BIGINT IS NULL OR review.source_id = $3)
             AND ($4::TEXT = '' OR dictionary.type_code = $4)
             AND ($6::TEXT = '' OR review.source_value ILIKE '%' || $6 || '%')
             AND ($7::JSONB = '{}'::JSONB
               OR review.processor_version = $7::JSONB ->> review.source_id::TEXT)
             AND ($8::BIGINT[] IS NULL OR review.id = ANY($8))
           GROUP BY review.id, review.source_id, source.code, source.name,
                    review.reference_type_id, dictionary.type_code,
                    dictionary.type_name, review.scope, review.normalized_source_value,
                    review.context_key, review.source_value, review.review_status,
                    review.issue_reason, review.needs_decision_observation_count,
                    review.needs_decision_product_count, dictionary.target_scope,
                    review.last_seen_at, dictionary.dictionary_value_id,
                    dictionary.external_id, dictionary.target_name,
                    dictionary.slug, dictionary.taxonomy
         ), grouped AS MATERIALIZED (
           SELECT review_group_id, source_id, source_code, source_name,
                  reference_type_id, type_code, type_name, scope,
                  normalized_source_value, context_key, source_value,
                  review_status, issue_reason, observation_count, product_count,
                  target_scope, last_seen_at,
                  COUNT(*)::INTEGER AS target_count,
                  MAX(linked_reference_count)::INTEGER AS linked_reference_count,
                  JSONB_AGG(JSONB_BUILD_OBJECT(
                    'dictionaryValueId', dictionary_value_id::TEXT,
                    'externalId', external_id,
                    'name', target_name,
                    'slug', slug,
                    'taxonomy', taxonomy
                  ) ORDER BY target_name, external_id) AS targets
           FROM dictionary_matches
           GROUP BY review_group_id, source_id, source_code, source_name,
                    reference_type_id, type_code, type_name, scope,
                    normalized_source_value, context_key, source_value,
                    review_status, issue_reason, observation_count, product_count,
                    target_scope, last_seen_at
         ), classified AS MATERIALIZED (
           SELECT grouped.*,
                  CASE
                    WHEN review_status = 'ambiguous' OR linked_reference_count > 1 THEN 'conflict'
                    WHEN target_count = 1 THEN 'ready'
                    ELSE 'duplicate'
                  END AS match_status,
                  CASE
                    WHEN review_status = 'ambiguous' THEN COALESCE(issue_reason, 'rule_ambiguous')
                    WHEN linked_reference_count > 1 THEN 'target_mapping_ambiguous'
                    ELSE issue_reason
                  END AS match_issue_reason
           FROM grouped
         ), summary AS (
           SELECT COUNT(*) FILTER (WHERE match_status = 'ready')::INTEGER AS ready_count,
                  COALESCE(SUM(product_count) FILTER (WHERE match_status = 'ready'), 0)::INTEGER AS ready_product_count,
                  COUNT(*) FILTER (WHERE match_status = 'duplicate')::INTEGER AS duplicate_count,
                  COUNT(*) FILTER (WHERE match_status = 'conflict')::INTEGER AS conflict_count
           FROM classified
         ), filtered AS MATERIALIZED (
           SELECT * FROM classified
           WHERE $5::TEXT = '' OR match_status = $5
         ), page AS (
           SELECT * FROM filtered
           ORDER BY CASE match_status WHEN 'ready' THEN 0 WHEN 'duplicate' THEN 1 ELSE 2 END,
                    product_count DESC, last_seen_at DESC, review_group_id DESC
           LIMIT $9 OFFSET $10
         )
         SELECT
           (SELECT COUNT(*)::INTEGER FROM filtered) AS total,
           summary.ready_count,
           summary.ready_product_count,
           summary.duplicate_count,
           summary.conflict_count,
           COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
             'reviewGroupId', page.review_group_id::TEXT,
             'sourceId', page.source_id::TEXT,
             'sourceCode', page.source_code,
             'sourceName', page.source_name,
             'typeCode', page.type_code,
             'typeName', page.type_name,
             'scope', page.scope,
             'normalizedSourceValue', page.normalized_source_value,
             'contextKey', page.context_key,
             'sourceValue', page.source_value,
             'productCount', page.product_count,
             'observationCount', page.observation_count,
             'targetScope', page.target_scope,
             'matchStatus', page.match_status,
             'issueReason', page.match_issue_reason,
             'targets', page.targets
           ) ORDER BY CASE page.match_status WHEN 'ready' THEN 0 WHEN 'duplicate' THEN 1 ELSE 2 END,
                      page.product_count DESC, page.last_seen_at DESC, page.review_group_id DESC)
             FROM page), '[]'::JSONB) AS items
         FROM summary`,
        [
          query.targetId,
          JSON.stringify(capabilities),
          query.sourceId ?? null,
          query.typeCode ?? "",
          query.status ?? "",
          query.search?.trim() ?? "",
          processorVersions(query.currentProcessorVersions),
          query.reviewGroupIds ?? null,
          query.limit,
          query.offset,
        ],
      );
      const row = result.rows[0]!;
      return {
        items: exactMatchItems(row.items),
        total: Number(row.total ?? 0),
        summary: {
          readyCount: Number(row.ready_count ?? 0),
          readyProductCount: Number(row.ready_product_count ?? 0),
          duplicateCount: Number(row.duplicate_count ?? 0),
          conflictCount: Number(row.conflict_count ?? 0),
        },
      };
    });
  }

  async listReviewExamples(query: ClassificationReviewExamplesQuery): Promise<ClassificationReviewExamplesResult> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `WITH review_group AS MATERIALIZED (
          SELECT review.*
          FROM classification_review_groups review
          WHERE review.id = $1
            AND ($2::JSONB = '{}'::JSONB
              OR review.processor_version = $2::JSONB ->> review.source_id::TEXT)
        ), candidate AS MATERIALIZED (
          SELECT definition.id
          FROM review_group review
          JOIN classification_candidates definition
            ON definition.source_id = review.source_id
           AND definition.reference_type_id = review.reference_type_id
           AND definition.scope = review.scope
           AND definition.normalized_source_value = review.normalized_source_value
           AND definition.context_key = review.context_key
        ), matching_links AS MATERIALIZED (
          SELECT DISTINCT ON (link.source_product_id)
            link.id AS observation_id,
            link.source_product_id,
            link.evidence_id,
            link.last_seen_at
          FROM review_group review
          JOIN candidate ON TRUE
          JOIN source_product_classification_links link ON link.candidate_id = candidate.id
          JOIN source_product_classification_states state
            ON state.source_product_id = link.source_product_id
           AND state.processor_version = review.processor_version
          WHERE link.active = TRUE
            AND link.status = review.observation_status
            AND link.status IN ('unresolved', 'ambiguous')
          ORDER BY link.source_product_id, link.last_seen_at DESC, link.id DESC
        ), filtered_links AS MATERIALIZED (
          SELECT matching.*
          FROM matching_links matching
          WHERE $3::TEXT = ''
             OR EXISTS (
               SELECT 1
               FROM source_products product
               JOIN internal_products internal ON internal.source_product_id = product.id
               WHERE product.id = matching.source_product_id
                 AND (
                   product.id::TEXT = $3
                   OR product.source_key ILIKE '%' || $3 || '%'
                   OR COALESCE(internal.data->>'title', '') ILIKE '%' || $3 || '%'
                   OR COALESCE(internal.data->>'sku', '') ILIKE '%' || $3 || '%'
                 )
             )
        ), selected_links AS MATERIALIZED (
          SELECT matching.*
          FROM filtered_links matching
          ORDER BY matching.last_seen_at DESC, matching.observation_id DESC
          LIMIT $4 OFFSET $5
        ), selected_products AS MATERIALIZED (
          SELECT selected.*, product.source_key,
                 internal.data->>'title' AS title,
                 internal.data->>'sku' AS sku,
                 evidence.evidence
          FROM selected_links selected
          JOIN source_products product ON product.id = selected.source_product_id
          JOIN internal_products internal ON internal.source_product_id = selected.source_product_id
          JOIN source_product_classification_evidence evidence ON evidence.id = selected.evidence_id
        )
        SELECT
          (SELECT COUNT(*)::INTEGER FROM filtered_links) AS total,
          COALESCE((
            SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
              'observation_id', selected.observation_id,
              'source_product_id', selected.source_product_id,
              'source_key', selected.source_key,
              'title', selected.title,
              'sku', selected.sku,
              'evidence', selected.evidence,
              'target_snapshots', COALESCE((
                SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
                  'target_id', snapshot.target_id::TEXT,
                  'external_id', snapshot.external_id,
                  'snapshot', JSONB_BUILD_OBJECT(
                    'product', JSONB_BUILD_OBJECT(
                      'taxonomies', COALESCE(snapshot.payload->'product'->'taxonomies', '{}'::JSONB)
                    )
                  )
                ) ORDER BY snapshot.target_id)
                FROM target_product_snapshots snapshot
                WHERE snapshot.source_product_id = selected.source_product_id
              ), '[]'::JSONB)
            ) ORDER BY selected.last_seen_at DESC, selected.observation_id DESC)
            FROM selected_products selected
          ), '[]'::JSONB) AS examples`,
        [
          query.reviewGroupId,
          processorVersions(query.currentProcessorVersions),
          query.search?.trim() ?? "",
          query.limit,
          query.offset,
        ],
      );
      return {
        items: reviewExamples(result.rows[0]?.examples),
        total: Number(result.rows[0]?.total ?? 0),
      };
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
    currentProcessorVersion?: string,
    conditions: readonly ClassificationRuleConditionRecord[] = [],
  ): Promise<readonly ClassificationRuleCandidateRecord[]> {
    return withClient(this.pool, async (client) => {
      const filters = ruleCandidateFilters(conditions, 4);
      const result = await client.query<DatabaseRow>(
        `SELECT
           observation.id AS observation_id,
           observation.source_id,
           observation.source_product_id,
           product.source_key,
           internal.data->>'title' AS title,
           internal.data->>'sku' AS sku,
           observation.mapping_id,
           CASE WHEN observation.mapping_id IS NULL THEN NULL ELSE observation.resolved_reference_value_id END AS mapping_reference_value_id,
           observation.candidate_key,
           $2::TEXT AS type_code,
           observation.scope,
           observation.subject_kind,
           observation.subject_key,
           observation.source_value,
           observation.context,
           observation.evidence
         FROM ${classificationObservationReadModelSql} observation
         JOIN source_products product ON product.id = observation.source_product_id
         LEFT JOIN internal_products internal ON internal.source_product_id = product.id
         WHERE observation.active = TRUE
           AND observation.source_id = $1
           AND observation.reference_type_id = (
             SELECT id FROM reference_types WHERE code = $2
           )
           AND ($3::TEXT IS NULL OR observation.processor_version = $3)
           ${filters.sql}
         ORDER BY observation.id`,
        [sourceId, typeCode, currentProcessorVersion ?? null, ...filters.values],
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
          mappingId: nullableText(row.mapping_id),
          mappingReferenceValueId: nullableText(row.mapping_reference_value_id),
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

  async getRule(ruleId: string): Promise<ClassificationRuleAdminRecord | null> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `SELECT rule.*, type.code AS type_code
         FROM source_reference_rules rule
         JOIN reference_types type ON type.id = rule.reference_type_id
         WHERE rule.id = $1 AND rule.deleted_at IS NULL`,
        [ruleId],
      );
      const row = result.rows[0];
      return row === undefined ? null : {
        id: String(row.id),
        sourceId: String(row.source_id),
        typeCode: String(row.type_code),
        name: String(row.name),
        priority: Number(row.priority),
        conditions: ruleConditions(row.conditions),
        referenceValueId: String(row.reference_value_id),
        revision: String(row.revision),
        enabled: row.enabled === true,
      };
    });
  }

  async listRuleConditionFields(
    sourceId: string,
    typeCode: string,
    currentProcessorVersion?: string,
  ): Promise<readonly ClassificationRuleConditionFieldOption[]> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `WITH type_definition AS MATERIALIZED (
           SELECT id FROM reference_types WHERE code = $2
         ), current_evidence AS MATERIALIZED (
           SELECT DISTINCT link.evidence_id
           FROM classification_candidates candidate
           JOIN type_definition type ON type.id = candidate.reference_type_id
           JOIN source_product_classification_links link ON link.candidate_id = candidate.id
           JOIN source_product_classification_states state ON state.source_product_id = link.source_product_id
           WHERE candidate.source_id = $1
             AND link.active = TRUE
             AND ($3::TEXT IS NULL OR state.processor_version = $3)
         ), fields AS (
           SELECT UNNEST(ARRAY['sourceValue', 'scope', 'subjectKind'])::TEXT AS field
           UNION
           SELECT 'context.' || entry.key
           FROM classification_candidates candidate
           JOIN type_definition type ON type.id = candidate.reference_type_id
           CROSS JOIN LATERAL JSONB_EACH(candidate.context) entry
           WHERE candidate.source_id = $1
             AND JSONB_TYPEOF(entry.value) IN ('string', 'number', 'boolean')
           UNION
           SELECT 'evidence.' || entry.key
           FROM current_evidence current
           JOIN source_product_classification_evidence evidence ON evidence.id = current.evidence_id
           CROSS JOIN LATERAL JSONB_EACH(evidence.evidence) entry
           WHERE JSONB_TYPEOF(entry.value) IN ('string', 'number', 'boolean')
         )
         SELECT field, ARRAY[]::TEXT[] AS examples
         FROM fields
         ORDER BY CASE field WHEN 'sourceValue' THEN 0 WHEN 'scope' THEN 1 WHEN 'subjectKind' THEN 2 ELSE 3 END, field`,
        [sourceId, typeCode, currentProcessorVersion ?? null],
      );
      return result.rows.map((row) => ({ field: String(row.field), exampleValues: stringArray(row.examples) }));
    });
  }

  async listConfigurationHistory(
    kind: "mapping" | "rule" | "target_mapping" | "projection",
    id: string,
  ): Promise<readonly ClassificationConfigHistoryRecord[]> {
    return withClient(this.pool, async (client) => {
      const query = kind === "mapping"
        ? `SELECT id, action, previous_value, new_value, actor, reason, created_at
           FROM source_reference_decision_history WHERE mapping_id = $1 ORDER BY created_at DESC, id DESC`
        : kind === "rule"
          ? `SELECT id, action, previous_value, new_value, actor, reason, created_at
             FROM source_reference_decision_history WHERE rule_id = $1 ORDER BY created_at DESC, id DESC`
          : kind === "target_mapping"
            ? `SELECT id, action, previous_value, new_value, actor, reason, created_at
               FROM target_value_mapping_history WHERE mapping_id = $1 ORDER BY created_at DESC, id DESC`
            : `SELECT id, action, previous_value, new_value, actor, reason, created_at
               FROM target_classification_projection_history WHERE projection_id = $1 ORDER BY created_at DESC, id DESC`;
      const result = await client.query<DatabaseRow>(query, [id]);
      return result.rows.map((row) => ({
        id: String(row.id),
        action: String(row.action),
        previousValue: row.previous_value === null || row.previous_value === undefined ? null : jsonObject(row.previous_value),
        newValue: row.new_value === null || row.new_value === undefined ? null : jsonObject(row.new_value),
        actor: nullableText(row.actor),
        reason: nullableText(row.reason),
        createdAt: timestamp(row.created_at),
      }));
    });
  }

  async previewDecision(input: SaveClassificationDecisionInput): Promise<ClassificationDecisionPreview> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `WITH candidate AS MATERIALIZED (
           SELECT definition.id
           FROM classification_candidates definition
           JOIN reference_types type ON type.id = definition.reference_type_id
           WHERE definition.source_id = $1
             AND type.code = $2
             AND definition.scope = $3
             AND definition.normalized_source_value = $4
             AND definition.context_key = $5
         ), matched AS MATERIALIZED (
           SELECT link.id, link.source_product_id, link.last_seen_at, link.evidence_id
           FROM candidate
           JOIN source_product_classification_links link ON link.candidate_id = candidate.id
           WHERE link.active = TRUE
         ), example_links AS MATERIALIZED (
           SELECT matched.*
           FROM matched
           ORDER BY matched.last_seen_at DESC, matched.id DESC
           LIMIT 5
         ), examples AS (
           SELECT link.id AS observation_id, link.source_product_id,
                  product.source_key, internal.data->>'title' AS title,
                  internal.data->>'sku' AS sku, evidence.evidence,
                  '[]'::JSONB AS target_snapshots
           FROM example_links link
           JOIN source_products product ON product.id = link.source_product_id
           LEFT JOIN internal_products internal ON internal.source_product_id = link.source_product_id
           JOIN source_product_classification_evidence evidence ON evidence.id = link.evidence_id
         ), existing AS (
           SELECT mapping.status, mapping.reference_value_id
           FROM source_reference_mappings mapping
           JOIN reference_types type ON type.id = mapping.reference_type_id
           WHERE mapping.source_id = $1 AND type.code = $2 AND mapping.scope = $3
             AND mapping.normalized_source_value = $4 AND mapping.context_key = $5
         )
         SELECT (SELECT COUNT(*)::INTEGER FROM matched) AS observation_count,
                (SELECT COUNT(DISTINCT source_product_id)::INTEGER FROM matched) AS product_count,
                (SELECT status FROM existing) AS current_status,
                (SELECT reference_value_id FROM existing) AS current_reference_value_id,
                COALESCE((SELECT JSONB_AGG(TO_JSONB(example) ORDER BY example.observation_id)
                          FROM examples example), '[]'::JSONB) AS examples`,
        [input.sourceId, input.typeCode, input.scope, input.normalizedSourceValue, input.contextKey],
      );
      const row = result.rows[0]!;
      const proposedStatus = input.action === "confirm" ? "confirmed" as const : "ignored" as const;
      const proposedReferenceValueId = input.action === "confirm" ? input.referenceValueId ?? null : null;
      const currentStatus = nullableText(row.current_status) as ClassificationDecisionPreview["currentStatus"];
      const currentReferenceValueId = nullableText(row.current_reference_value_id);
      return {
        observationCount: Number(row.observation_count),
        productCount: Number(row.product_count),
        currentReferenceValueId,
        proposedReferenceValueId,
        currentStatus,
        proposedStatus,
        unchanged: currentStatus === proposedStatus && currentReferenceValueId === proposedReferenceValueId && input.targetLink === undefined,
        examples: reviewExamples(row.examples),
      };
    });
  }

  async getDecisionContext(key: ClassificationDecisionKey): Promise<ClassificationDecisionContext | null> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `SELECT observation.id, source.code AS source_code, observation.source_value
         FROM ${classificationObservationReadModelSql} observation
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

  async getTargetValueMapping(mappingId: string): Promise<TargetValueMappingAdminRecord | null> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `SELECT mapping.*, type.code AS type_code
         FROM target_value_mappings mapping
         JOIN reference_values value ON value.id = mapping.reference_value_id
         JOIN reference_types type ON type.id = value.type_id
         WHERE mapping.id = $1`,
        [mappingId],
      );
      return result.rows[0] === undefined ? null : mapTargetValueMappingAdmin(result.rows[0]);
    });
  }

  async previewTargetValueMapping(input: TargetValueMappingCommand): Promise<TargetClassificationProjectionPreview> {
    return withClient(this.pool, (client) => this.previewTargetValueMappingWithClient(client, input));
  }

  async updateTargetValueMapping(input: TargetValueMappingCommand): Promise<{
    readonly mapping: TargetValueMappingAdminRecord;
    readonly preview: TargetClassificationProjectionPreview;
    readonly affectedProductCount: number;
  }> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const previousResult = await client.query<DatabaseRow>(
          `SELECT mapping.*, type.code AS type_code
           FROM target_value_mappings mapping
           JOIN reference_values value ON value.id = mapping.reference_value_id
           JOIN reference_types type ON type.id = value.type_id
           WHERE mapping.id = $1 FOR UPDATE OF mapping`,
          [input.mappingId],
        );
        const previous = previousResult.rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Target value mapping", input.mappingId);
        const preview = await this.previewTargetValueMappingWithClient(client, input);
        const dictionaryResult = await client.query<DatabaseRow>(
          `SELECT * FROM target_dictionary_values
           WHERE id = $1 AND target_id = $2 AND active = TRUE`,
          [input.dictionaryValueId, previous.target_id],
        );
        const dictionary = dictionaryResult.rows[0];
        if (dictionary === undefined) throw new EntityNotFoundError("Target dictionary value", input.dictionaryValueId);
        const unchanged = String(previous.dictionary_value_id) === input.dictionaryValueId && previous.active === true;
        const result = await client.query<DatabaseRow>(
          `UPDATE target_value_mappings
           SET external_value = $2, external_label = $3,
               metadata = $4::JSONB, dictionary_value_id = $5, active = TRUE,
               revision = CASE WHEN $6::BOOLEAN THEN revision ELSE revision + 1 END,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *, $7::TEXT AS type_code`,
          [
            input.mappingId,
            String(dictionary.external_id),
            String(dictionary.name),
            JSON.stringify({
              entityType: String(dictionary.entity_type),
              slug: nullableText(dictionary.slug),
              taxonomy: nullableText(dictionary.taxonomy),
              attributeCode: nullableText(dictionary.attribute_code),
            }),
            input.dictionaryValueId,
            unchanged,
            String(previous.type_code),
          ],
        );
        const row = result.rows[0]!;
        const relatedProjectionChanged = await this.syncRelatedReferenceProjections(
          client,
          String(previous.target_id),
          String(previous.reference_value_id),
          input.relatedProjectionSyncs ?? [],
          input.actor,
          input.reason,
        );
        if (!unchanged) {
          await client.query(
            `INSERT INTO target_value_mapping_history (
               mapping_id, action, previous_value, new_value, actor, reason
             ) VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`,
            [input.mappingId, previous.active === true ? "update" : "reactivate", JSON.stringify(previous), JSON.stringify(row), input.actor, input.reason ?? null],
          );
        }
        const affectedProductCount = unchanged && !relatedProjectionChanged ? 0 : await enqueueProducts(client, preview.affectedSourceProductIds);
        await client.query("COMMIT");
        return { mapping: mapTargetValueMappingAdmin(row), preview, affectedProductCount };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async setTargetValueMappingEnabled(input: {
    readonly mappingId: string;
    readonly enabled: boolean;
    readonly actor: string;
    readonly reason?: string;
  }): Promise<{ readonly affectedProductCount: number; readonly revision: string }> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const previousResult = await client.query<DatabaseRow>(
          `SELECT * FROM target_value_mappings WHERE id = $1 FOR UPDATE`,
          [input.mappingId],
        );
        const previous = previousResult.rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Target value mapping", input.mappingId);
        const unchanged = previous.active === input.enabled;
        const result = await client.query<DatabaseRow>(
          `UPDATE target_value_mappings
           SET active = $2,
               revision = CASE WHEN $3::BOOLEAN THEN revision ELSE revision + 1 END,
               updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [input.mappingId, input.enabled, unchanged],
        );
        const row = result.rows[0]!;
        if (!unchanged) {
          await client.query(
            `INSERT INTO target_value_mapping_history (
               mapping_id, action, previous_value, new_value, actor, reason
             ) VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`,
            [input.mappingId, input.enabled ? "reactivate" : "deactivate", JSON.stringify(previous), JSON.stringify(row), input.actor, input.reason ?? null],
          );
        }
        const affected = await client.query<DatabaseRow>(
          `SELECT DISTINCT source_product_id
           FROM ${classificationObservationReadModelSql} observation
           WHERE active = TRUE AND resolved_reference_value_id = $1`,
          [previous.reference_value_id],
        );
        const affectedProductCount = unchanged ? 0 : await enqueueProducts(client, affected.rows.map((row) => String(row.source_product_id)));
        await client.query("COMMIT");
        return { affectedProductCount, revision: String(row.revision) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async listTargetProjections(
    targetId: string,
    resolutionKind: "mapping" | "rule",
    resolutionId: string,
  ): Promise<readonly TargetClassificationProjectionRecord[]> {
    return withClient(this.pool, async (client) => {
      const column = resolutionKind === "mapping" ? "mapping_id" : "rule_id";
      const result = await client.query<DatabaseRow>(
        `SELECT projection.*, dictionary.external_id AS external_value, dictionary.name AS external_label
         FROM target_classification_projections projection
         JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
         WHERE projection.target_id = $1
           AND projection.${column} = $2
           AND projection.active = TRUE
           AND dictionary.active = TRUE
         ORDER BY projection.target_scope, dictionary.name, projection.id`,
        [targetId, resolutionId],
      );
      return result.rows.map(mapTargetClassificationProjection);
    });
  }

  async createTargetValueMapping(input: CreateTargetValueMappingCommand): Promise<{
    readonly mapping: TargetValueMappingAdminRecord;
    readonly preview: TargetClassificationProjectionPreview;
    readonly affectedProductCount: number;
  }> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const preview = await this.previewReferenceProjectionWithClient(client, input);
        if (input.targetCardinality === "single" && preview.cardinalityConflicts.length > 0) {
          throw new IntegrationContractError(`Target scope ${input.targetScope} accepts one value`);
        }
        const previousResult = await client.query<DatabaseRow>(
          `SELECT * FROM target_value_mappings
           WHERE target_id = $1 AND reference_value_id = $2 AND target_scope = $3 FOR UPDATE`,
          [input.targetId, input.referenceValueId, input.targetScope],
        );
        const previous = previousResult.rows[0];
        const result = await client.query<DatabaseRow>(
          `WITH selected_reference AS (
             SELECT value.id FROM reference_values value JOIN reference_types type ON type.id = value.type_id
             WHERE value.id = $2 AND value.enabled = TRUE AND type.code = $5
           ), selected_dictionary AS (
             SELECT * FROM target_dictionary_values WHERE id = $4 AND target_id = $1 AND active = TRUE
           ), saved AS (
             INSERT INTO target_value_mappings (
               target_id, reference_value_id, target_scope, external_value, external_label,
               metadata, dictionary_value_id, active, revision
             )
             SELECT $1, selected_reference.id, $3, selected_dictionary.external_id, selected_dictionary.name,
                    JSONB_BUILD_OBJECT('entityType', selected_dictionary.entity_type, 'slug', selected_dictionary.slug,
                      'taxonomy', selected_dictionary.taxonomy, 'attributeCode', selected_dictionary.attribute_code),
                    selected_dictionary.id, TRUE, 1
             FROM selected_reference CROSS JOIN selected_dictionary
             ON CONFLICT (target_id, reference_value_id, target_scope)
             DO UPDATE SET external_value = EXCLUDED.external_value, external_label = EXCLUDED.external_label,
               metadata = EXCLUDED.metadata, dictionary_value_id = EXCLUDED.dictionary_value_id, active = TRUE,
               revision = CASE WHEN target_value_mappings.dictionary_value_id = EXCLUDED.dictionary_value_id
                 AND target_value_mappings.active THEN target_value_mappings.revision ELSE target_value_mappings.revision + 1 END,
               updated_at = NOW()
             RETURNING *
           )
           SELECT saved.*, $5::TEXT AS type_code FROM saved`,
          [input.targetId, input.referenceValueId, input.targetScope, input.dictionaryValueId, input.typeCode],
        );
        const row = result.rows[0];
        if (row === undefined) throw new EntityNotFoundError("Internal value or target dictionary value", `${input.referenceValueId}/${input.dictionaryValueId}`);
        const mapping = mapTargetValueMappingAdmin(row);
        const changed = previous === undefined || previous.active !== true || String(previous.dictionary_value_id) !== input.dictionaryValueId;
        const relatedProjectionChanged = await this.syncRelatedReferenceProjections(
          client,
          input.targetId,
          input.referenceValueId,
          input.relatedProjectionSyncs ?? [],
          input.actor,
          input.reason,
        );
        if (changed) {
          await client.query(
            `INSERT INTO target_value_mapping_history (mapping_id, action, previous_value, new_value, actor, reason)
             VALUES ($1, 'link', $2::JSONB, $3::JSONB, $4, $5)`,
            [mapping.id, previous === undefined ? null : JSON.stringify(previous), JSON.stringify(row), input.actor, input.reason ?? null],
          );
        }
        const affectedProductCount = changed || relatedProjectionChanged ? await enqueueProducts(client, preview.affectedSourceProductIds) : 0;
        await client.query("COMMIT");
        return { mapping, preview, affectedProductCount };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async listReferenceCatalog(query: ClassificationReferenceCatalogQuery): Promise<ClassificationReferenceCatalogResult> {
    return withClient(this.pool, async (client) => {
      const parameters = [query.typeCode ?? "", query.search?.trim() ?? "", query.limit, query.offset];
      const where = `value.enabled = TRUE AND type.enabled = TRUE
        AND ($1::TEXT = '' OR type.code = $1)
        AND ($2::TEXT = '' OR value.name ILIKE '%' || $2 || '%' OR value.code ILIKE '%' || $2 || '%')`;
      const [items, total] = await Promise.all([
        client.query<DatabaseRow>(
          `SELECT value.id, type.code AS type_code, type.name AS type_name, value.code, value.name,
                  value.parent_id, value.metadata,
                  (SELECT COUNT(DISTINCT observation.source_product_id)::INTEGER
                   FROM ${classificationObservationReadModelSql} observation
                   WHERE observation.active = TRUE AND observation.status = 'resolved'
                     AND observation.resolved_reference_value_id = value.id) AS product_count,
                  (SELECT COUNT(*)::INTEGER FROM source_reference_mappings mapping
                   WHERE mapping.reference_value_id = value.id AND mapping.status = 'confirmed') AS mapping_count,
                  (SELECT COUNT(*)::INTEGER FROM source_reference_rules rule
                   WHERE rule.reference_value_id = value.id AND rule.enabled = TRUE AND rule.deleted_at IS NULL) AS rule_count,
                  COALESCE((
                    SELECT JSONB_AGG(output ORDER BY output->>'kind', output->>'targetScope', output->>'label')
                    FROM (
                      SELECT JSONB_BUILD_OBJECT(
                        'kind', 'primary', 'id', mapping.id::TEXT, 'targetId', mapping.target_id::TEXT,
                        'targetCode', target.code, 'targetScope', mapping.target_scope,
                        'dictionaryValueId', mapping.dictionary_value_id::TEXT,
                        'externalId', mapping.external_value, 'label', mapping.external_label,
                        'taxonomy', dictionary.taxonomy
                      ) AS output
                      FROM target_value_mappings mapping
                      JOIN targets target ON target.id = mapping.target_id
                      LEFT JOIN target_dictionary_values dictionary ON dictionary.id = mapping.dictionary_value_id
                      WHERE mapping.reference_value_id = value.id AND mapping.active = TRUE
                      UNION ALL
                      SELECT JSONB_BUILD_OBJECT(
                        'kind', 'additional', 'id', projection.id::TEXT, 'targetId', projection.target_id::TEXT,
                        'targetCode', target.code, 'targetScope', projection.target_scope,
                        'dictionaryValueId', projection.dictionary_value_id::TEXT,
                        'externalId', dictionary.external_id, 'label', dictionary.name,
                        'taxonomy', dictionary.taxonomy
                      ) AS output
                      FROM target_reference_projections projection
                      JOIN targets target ON target.id = projection.target_id
                      JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
                      WHERE projection.reference_value_id = value.id AND projection.active = TRUE AND dictionary.active = TRUE
                    ) outputs
                  ), '[]'::JSONB) AS outputs
           FROM reference_values value
           JOIN reference_types type ON type.id = value.type_id
           WHERE ${where}
           ORDER BY type.name, value.name, value.id
           LIMIT $3 OFFSET $4`,
          parameters,
        ),
        client.query<DatabaseRow>(
          `SELECT COUNT(*)::INTEGER AS total FROM reference_values value
           JOIN reference_types type ON type.id = value.type_id WHERE ${where}`,
          parameters.slice(0, 2),
        ),
      ]);
      return {
        items: items.rows.map((row) => ({
          id: String(row.id), typeCode: String(row.type_code), typeName: String(row.type_name),
          code: String(row.code), name: String(row.name), parentId: nullableText(row.parent_id),
          metadata: jsonObject(row.metadata), productCount: Number(row.product_count ?? 0),
          mappingCount: Number(row.mapping_count ?? 0), ruleCount: Number(row.rule_count ?? 0),
          outputs: Array.isArray(row.outputs) ? row.outputs.map((entry) => {
            const output = jsonObject(entry);
            return {
              kind: output.kind === "additional" ? "additional" as const : "primary" as const,
              id: String(output.id), targetId: String(output.targetId), targetCode: String(output.targetCode),
              targetScope: String(output.targetScope), dictionaryValueId: String(output.dictionaryValueId),
              externalId: String(output.externalId), label: String(output.label), taxonomy: nullableText(output.taxonomy),
            };
          }) : [],
        })),
        total: Number(total.rows[0]?.total ?? 0),
      };
    });
  }

  async listReferenceProjections(targetId: string, referenceValueId: string): Promise<readonly TargetReferenceProjectionRecord[]> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `SELECT projection.*, dictionary.external_id AS external_value, dictionary.name AS external_label
         FROM target_reference_projections projection
         JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
         WHERE projection.target_id = $1
           AND projection.reference_value_id = $2
           AND projection.active = TRUE
           AND dictionary.active = TRUE
         ORDER BY projection.target_scope, dictionary.name, projection.id`,
        [targetId, referenceValueId],
      );
      return result.rows.map(mapTargetReferenceProjection);
    });
  }

  async previewReferenceProjection(input: TargetReferenceProjectionCommand): Promise<TargetClassificationProjectionPreview> {
    return withClient(this.pool, (client) => this.previewReferenceProjectionWithClient(client, input));
  }

  async createReferenceProjection(input: TargetReferenceProjectionCommand): Promise<{
    readonly projection: TargetReferenceProjectionRecord;
    readonly preview: TargetClassificationProjectionPreview;
    readonly affectedProductCount: number;
  }> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const preview = await this.previewReferenceProjectionWithClient(client, input);
        if (preview.duplicate === null && input.targetCardinality === "single" && preview.cardinalityConflicts.length > 0) {
          throw new IntegrationContractError(`Target scope ${input.targetScope} accepts one value`);
        }
        const previousResult = await client.query<DatabaseRow>(
          `SELECT * FROM target_reference_projections
           WHERE target_id = $1 AND reference_value_id = $2
             AND target_scope = $3 AND dictionary_value_id = $4 FOR UPDATE`,
          [input.targetId, input.referenceValueId, input.targetScope, input.dictionaryValueId],
        );
        const previous = previousResult.rows[0];
        const result = await client.query<DatabaseRow>(
          `WITH selected_reference AS (
             SELECT id FROM reference_values WHERE id = $2 AND enabled = TRUE
           ), selected_dictionary AS (
             SELECT id FROM target_dictionary_values WHERE id = $4 AND target_id = $1 AND active = TRUE
           ), saved AS (
             INSERT INTO target_reference_projections (
               target_id, reference_value_id, target_scope, dictionary_value_id, created_by
             )
             SELECT $1, selected_reference.id, $3, selected_dictionary.id, $5
             FROM selected_reference CROSS JOIN selected_dictionary
             ON CONFLICT (target_id, reference_value_id, target_scope, dictionary_value_id)
             DO UPDATE SET active = TRUE,
               revision = CASE WHEN target_reference_projections.active THEN target_reference_projections.revision ELSE target_reference_projections.revision + 1 END,
               updated_at = NOW()
             RETURNING *
           )
           SELECT saved.*, dictionary.external_id AS external_value, dictionary.name AS external_label
           FROM saved JOIN target_dictionary_values dictionary ON dictionary.id = saved.dictionary_value_id`,
          [input.targetId, input.referenceValueId, input.targetScope, input.dictionaryValueId, input.actor],
        );
        const row = result.rows[0];
        if (row === undefined) throw new EntityNotFoundError("Internal value or target dictionary value", `${input.referenceValueId}/${input.dictionaryValueId}`);
        const projection = mapTargetReferenceProjection(row);
        const changed = previous === undefined || previous.active !== true;
        if (changed) {
          await client.query(
            `INSERT INTO target_reference_projection_history (
               projection_id, action, previous_value, new_value, actor, reason
             ) VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`,
            [projection.id, previous === undefined ? "create" : "reactivate", previous === undefined ? null : JSON.stringify(previous), JSON.stringify(row), input.actor, input.reason ?? null],
          );
        }
        const affectedProductCount = changed ? await enqueueProducts(client, preview.affectedSourceProductIds) : 0;
        await client.query("COMMIT");
        return { projection, preview, affectedProductCount };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async deactivateReferenceProjection(input: {
    readonly targetId: string;
    readonly projectionId: string;
    readonly actor: string;
    readonly reason?: string;
  }): Promise<{ readonly affectedProductCount: number }> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const previousResult = await client.query<DatabaseRow>(
          `SELECT * FROM target_reference_projections WHERE id = $1 AND target_id = $2 AND active = TRUE FOR UPDATE`,
          [input.projectionId, input.targetId],
        );
        const previous = previousResult.rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Internal value assignment", input.projectionId);
        const affected = await client.query<DatabaseRow>(
          `SELECT DISTINCT source_product_id FROM ${classificationObservationReadModelSql} observation
           WHERE active = TRUE AND status = 'resolved' AND resolved_reference_value_id = $1`,
          [previous.reference_value_id],
        );
        const result = await client.query<DatabaseRow>(
          `UPDATE target_reference_projections SET active = FALSE, revision = revision + 1, updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [input.projectionId],
        );
        await client.query(
          `INSERT INTO target_reference_projection_history (
             projection_id, action, previous_value, new_value, actor, reason
           ) VALUES ($1, 'deactivate', $2::JSONB, $3::JSONB, $4, $5)`,
          [input.projectionId, JSON.stringify(previous), JSON.stringify(result.rows[0]), input.actor, input.reason ?? null],
        );
        const affectedProductCount = await enqueueProducts(client, affected.rows.map((row) => String(row.source_product_id)));
        await client.query("COMMIT");
        return { affectedProductCount };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async getTargetProjection(targetId: string, projectionId: string): Promise<TargetClassificationProjectionRecord | null> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `SELECT projection.*, dictionary.external_id AS external_value, dictionary.name AS external_label
         FROM target_classification_projections projection
         JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
         WHERE projection.target_id = $1 AND projection.id = $2`,
        [targetId, projectionId],
      );
      return result.rows[0] === undefined ? null : mapTargetClassificationProjection(result.rows[0]);
    });
  }

  async previewTargetProjection(input: TargetClassificationProjectionCommand): Promise<TargetClassificationProjectionPreview> {
    return withClient(this.pool, (client) => this.previewTargetProjectionWithClient(client, input));
  }

  async createTargetProjection(input: TargetClassificationProjectionCommand): Promise<{
    readonly projection: TargetClassificationProjectionRecord;
    readonly preview: TargetClassificationProjectionPreview;
    readonly affectedProductCount: number;
  }> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const preview = await this.previewTargetProjectionWithClient(client, input);
        if (preview.duplicate === null && input.targetCardinality === "single" && preview.cardinalityConflicts.length > 0) {
          throw new IntegrationContractError(`Target scope ${input.targetScope} accepts one value`);
        }
        const column = input.resolutionKind === "mapping" ? "mapping_id" : "rule_id";
        const table = input.resolutionKind === "mapping" ? "source_reference_mappings" : "source_reference_rules";
        const predicate = input.resolutionKind === "mapping" ? "mapping_id IS NOT NULL" : "rule_id IS NOT NULL";
        const previousResult = await client.query<DatabaseRow>(
          `SELECT * FROM target_classification_projections
           WHERE target_id = $1 AND ${column} = $2 AND target_scope = $3 AND dictionary_value_id = $4
           FOR UPDATE`,
          [input.targetId, input.resolutionId, input.targetScope, input.dictionaryValueId],
        );
        const previous = previousResult.rows[0];
        const result = await client.query<DatabaseRow>(
          `WITH selected_resolution AS (
             SELECT id FROM ${table} WHERE id = $2
           ), selected_dictionary AS (
             SELECT id FROM target_dictionary_values
             WHERE id = $4 AND target_id = $1 AND active = TRUE
           ), saved AS (
             INSERT INTO target_classification_projections (
               target_id, ${column}, target_scope, dictionary_value_id,
               metadata, active, revision, created_by
             )
             SELECT $1, selected_resolution.id, $3, selected_dictionary.id,
                    '{}'::JSONB, TRUE, 1, $5
             FROM selected_resolution CROSS JOIN selected_dictionary
             ON CONFLICT (target_id, ${column}, target_scope, dictionary_value_id)
               WHERE ${predicate}
             DO UPDATE SET active = TRUE,
               revision = CASE WHEN target_classification_projections.active THEN target_classification_projections.revision ELSE target_classification_projections.revision + 1 END,
               updated_at = NOW()
             RETURNING *
           )
           SELECT saved.*, dictionary.external_id AS external_value, dictionary.name AS external_label
           FROM saved
           JOIN target_dictionary_values dictionary ON dictionary.id = saved.dictionary_value_id`,
          [input.targetId, input.resolutionId, input.targetScope, input.dictionaryValueId, input.actor],
        );
        const row = result.rows[0];
        if (row === undefined) throw new EntityNotFoundError("Target projection resolution or dictionary value", `${input.resolutionKind}/${input.resolutionId}/${input.dictionaryValueId}`);
        const projection = mapTargetClassificationProjection(row);
        const changed = previous === undefined || previous.active !== true;
        if (changed) {
          await client.query(
            `INSERT INTO target_classification_projection_history (
               projection_id, action, previous_value, new_value, actor, reason
             ) VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`,
            [
              projection.id,
              previous === undefined ? "create" : "reactivate",
              previous === undefined ? null : JSON.stringify(previous),
              JSON.stringify(row),
              input.actor,
              input.reason ?? null,
            ],
          );
        }
        const affectedProductCount = changed ? await enqueueProducts(client, preview.affectedSourceProductIds) : 0;
        await client.query("COMMIT");
        return { projection, preview, affectedProductCount };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async updateTargetProjection(input: TargetClassificationProjectionCommand & { readonly projectionId: string }): Promise<{
    readonly projection: TargetClassificationProjectionRecord;
    readonly preview: TargetClassificationProjectionPreview;
    readonly affectedProductCount: number;
  }> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const previousResult = await client.query<DatabaseRow>(
          `SELECT * FROM target_classification_projections
           WHERE id = $1 AND target_id = $2 FOR UPDATE`,
          [input.projectionId, input.targetId],
        );
        const previous = previousResult.rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Target projection", input.projectionId);
        const preview = await this.previewTargetProjectionWithClient(client, input, input.projectionId);
        if (preview.duplicate !== null) {
          throw new IntegrationContractError("An identical active target projection already exists");
        }
        if (input.targetCardinality === "single" && preview.cardinalityConflicts.length > 0) {
          throw new IntegrationContractError(`Target scope ${input.targetScope} accepts one value`);
        }
        const dictionaryResult = await client.query<DatabaseRow>(
          `SELECT id FROM target_dictionary_values
           WHERE id = $1 AND target_id = $2 AND active = TRUE`,
          [input.dictionaryValueId, input.targetId],
        );
        if (dictionaryResult.rows[0] === undefined) throw new EntityNotFoundError("Target dictionary value", input.dictionaryValueId);
        const unchanged = String(previous.target_scope) === input.targetScope
          && String(previous.dictionary_value_id) === input.dictionaryValueId
          && previous.active === true;
        const result = await client.query<DatabaseRow>(
          `UPDATE target_classification_projections
           SET target_scope = $3, dictionary_value_id = $4, active = TRUE,
               revision = CASE WHEN $5::BOOLEAN THEN revision ELSE revision + 1 END,
               updated_at = NOW()
           WHERE id = $1 AND target_id = $2
           RETURNING *`,
          [input.projectionId, input.targetId, input.targetScope, input.dictionaryValueId, unchanged],
        );
        const row = result.rows[0]!;
        const dictionary = await client.query<DatabaseRow>(
          `SELECT external_id, name FROM target_dictionary_values WHERE id = $1`,
          [input.dictionaryValueId],
        );
        const mapped = { ...row, external_value: dictionary.rows[0]!.external_id, external_label: dictionary.rows[0]!.name };
        const projection = mapTargetClassificationProjection(mapped);
        if (!unchanged) {
          await client.query(
            `INSERT INTO target_classification_projection_history (
               projection_id, action, previous_value, new_value, actor, reason
             ) VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`,
            [input.projectionId, previous.active === true ? "update" : "reactivate", JSON.stringify(previous), JSON.stringify(row), input.actor, input.reason ?? null],
          );
        }
        const affectedProductCount = unchanged ? 0 : await enqueueProducts(client, preview.affectedSourceProductIds);
        await client.query("COMMIT");
        return { projection, preview, affectedProductCount };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async deactivateTargetProjection(input: {
    readonly targetId: string;
    readonly projectionId: string;
    readonly actor: string;
    readonly reason?: string;
  }): Promise<{ readonly preview: TargetClassificationProjectionPreview; readonly affectedProductCount: number }> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const projectionResult = await client.query<DatabaseRow>(
          `SELECT * FROM target_classification_projections
           WHERE id = $1 AND target_id = $2 AND active = TRUE
           FOR UPDATE`,
          [input.projectionId, input.targetId],
        );
        const previous = projectionResult.rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Target projection", input.projectionId);
        const resolutionKind = previous.mapping_id === null || previous.mapping_id === undefined ? "rule" : "mapping";
        const resolutionId = String(resolutionKind === "mapping" ? previous.mapping_id : previous.rule_id);
        const preview = await this.previewTargetProjectionWithClient(client, {
          targetId: input.targetId,
          resolutionKind,
          resolutionId,
          targetScope: String(previous.target_scope),
          dictionaryValueId: String(previous.dictionary_value_id),
          targetCardinality: "multiple",
          actor: input.actor,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
        const deactivated = await client.query<DatabaseRow>(
          `UPDATE target_classification_projections
           SET active = FALSE, revision = revision + 1, updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [input.projectionId],
        );
        await client.query(
          `INSERT INTO target_classification_projection_history (
             projection_id, action, previous_value, new_value, actor, reason
           ) VALUES ($1, 'deactivate', $2::JSONB, $3::JSONB, $4, $5)`,
          [input.projectionId, JSON.stringify(previous), JSON.stringify(deactivated.rows[0]), input.actor, input.reason ?? null],
        );
        const affectedProductCount = await enqueueProducts(client, preview.affectedSourceProductIds);
        await client.query("COMMIT");
        return { preview, affectedProductCount };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async saveDecision(input: SaveClassificationDecisionInput): Promise<SaveClassificationDecisionResult> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const observationResult = await client.query<DatabaseRow>(
          `SELECT link.*, candidate.id AS candidate_id,
                  candidate.reference_type_id AS type_id,
                  candidate.context
           FROM classification_candidates candidate
           JOIN reference_types type ON type.id = candidate.reference_type_id
           JOIN source_product_classification_links link ON link.candidate_id = candidate.id
           WHERE link.active = TRUE
             AND candidate.source_id = $1
             AND type.code = $2
             AND candidate.scope = $3
             AND candidate.normalized_source_value = $4
             AND candidate.context_key = $5
           ORDER BY link.last_seen_at DESC, link.id
           LIMIT 1
           FOR UPDATE OF link`,
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

        let targetLinkChanged = false;
        if (input.targetLink !== undefined && dictionary !== undefined && referenceValueId !== null) {
          targetLinkChanged = await this.saveTargetLink(client, input, referenceValueId, dictionary);
        }

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

        if (!unchanged) {
          await markDecisionReviewGroupsWaiting(client, input, String(observation.type_id));
        }

        const affectedProductCount = unchanged && !targetLinkChanged
          ? 0
          : await enqueueDecisionProducts(
            client,
            String(observation.candidate_id),
            targetLinkChanged ? referenceValueId : null,
          );
        const affectedExportCount = 0;

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

  async findRuleTargetReference(input: {
    readonly typeCode: string;
    readonly targetId: string;
    readonly targetScope: string;
    readonly dictionaryValueId: string;
  }): Promise<string | null> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `SELECT mapping.reference_value_id
         FROM target_value_mappings mapping
         JOIN reference_values value ON value.id = mapping.reference_value_id AND value.enabled = TRUE
         JOIN reference_types type ON type.id = value.type_id AND type.enabled = TRUE
         WHERE mapping.target_id = $1
           AND mapping.target_scope = $2
           AND mapping.dictionary_value_id = $3
           AND mapping.active = TRUE
           AND type.code = $4
         ORDER BY mapping.id`,
        [input.targetId, input.targetScope, input.dictionaryValueId, input.typeCode],
      );
      if (result.rows.length > 1) {
        throw new IntegrationContractError("The target dictionary term is linked to more than one internal value");
      }
      return result.rows[0] === undefined ? null : String(result.rows[0].reference_value_id);
    });
  }

  async createRule(input: CreateClassificationRuleInput): Promise<CreateClassificationRuleResult> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const typeResult = await client.query<DatabaseRow>(
          `SELECT id AS type_id FROM reference_types WHERE code = $1 AND enabled = TRUE`,
          [input.typeCode],
        );
        const type = typeResult.rows[0];
        if (type === undefined) throw new EntityNotFoundError("Reference type", input.typeCode);
        let referenceValueId = input.referenceValueId ?? null;
        let dictionary: DatabaseRow | undefined;
        if (input.targetLink !== undefined) {
          const dictionaryResult = await client.query<DatabaseRow>(
            `SELECT * FROM target_dictionary_values
             WHERE id = $1 AND target_id = $2 AND active = TRUE
             FOR UPDATE`,
            [input.targetLink.dictionaryValueId, input.targetLink.targetId],
          );
          dictionary = dictionaryResult.rows[0];
          if (dictionary === undefined) throw new EntityNotFoundError("Target dictionary value", input.targetLink.dictionaryValueId);
          const linked = await client.query<DatabaseRow>(
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
            [input.targetLink.targetId, input.targetLink.targetScope, input.targetLink.dictionaryValueId, type.type_id],
          );
          if (linked.rows.length > 1) {
            throw new IntegrationContractError("The target dictionary term is linked to more than one internal value");
          }
          const linkedReferenceValueId = linked.rows[0] === undefined ? null : String(linked.rows[0].reference_value_id);
          if (referenceValueId !== null && linkedReferenceValueId !== null && referenceValueId !== linkedReferenceValueId) {
            throw new IntegrationContractError("The target dictionary term is linked to another internal value");
          }
          referenceValueId = referenceValueId ?? linkedReferenceValueId;
          if (referenceValueId === null) {
            if (input.generatedReferenceCode === undefined) {
              throw new IntegrationContractError("A generated reference code is required for a new internal value");
            }
            const created = await client.query<DatabaseRow>(
              `INSERT INTO reference_values (type_id, code, name, metadata)
               VALUES ($1, $2, $3, $4::JSONB)
               RETURNING id`,
              [type.type_id, input.generatedReferenceCode, dictionary.name, JSON.stringify({
                origin: "target_dictionary",
                targetId: input.targetLink.targetId,
                dictionaryValueId: input.targetLink.dictionaryValueId,
              })],
            );
            referenceValueId = String(created.rows[0]!.id);
          }
          await this.saveTargetLink(client, input, referenceValueId, dictionary);
        }
        if (referenceValueId === null) throw new IntegrationContractError("A classification rule requires a result value");
        const referenceResult = await client.query<DatabaseRow>(
          `SELECT id FROM reference_values WHERE id = $1 AND type_id = $2 AND enabled = TRUE`,
          [referenceValueId, type.type_id],
        );
        if (referenceResult.rows[0] === undefined) throw new EntityNotFoundError("Reference value", referenceValueId);

        const ruleResult = await client.query<DatabaseRow>(
          `INSERT INTO source_reference_rules (
             source_id, reference_type_id, name, priority, conditions,
             reference_value_id, enabled, revision, created_by, updated_by
           ) VALUES ($1, $2, $3, $4, $5::JSONB, $6, TRUE, 1, $7, $7)
           RETURNING *`,
          [input.sourceId, type.type_id, input.name, input.priority, JSON.stringify(input.conditions), referenceValueId, input.actor],
        );
        const rule = ruleResult.rows[0]!;
        await client.query(
          `INSERT INTO source_reference_decision_history (
             rule_id, action, new_value, actor, reason
           ) VALUES ($1, 'create', $2::JSONB, $3, $4)`,
          [rule.id, JSON.stringify(rule), input.actor, input.reason ?? null],
        );
        const affectedProductCount = await enqueueProducts(client, input.affectedSourceProductIds);
        await replaceRuleReviewCoverage(
          client,
          String(rule.id),
          String(rule.revision),
          input.matchedObservationIds,
        );
        await client.query("COMMIT");
        return {
          ruleId: String(rule.id),
          referenceValueId,
          revision: String(rule.revision),
          affectedProductCount,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async updateRule(input: UpdateClassificationRuleInput): Promise<UpdateClassificationRuleResult> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const previousResult = await client.query<DatabaseRow>(
          `SELECT rule.*, type.code AS type_code
           FROM source_reference_rules rule
           JOIN reference_types type ON type.id = rule.reference_type_id
           WHERE rule.id = $1 AND rule.deleted_at IS NULL
           FOR UPDATE`,
          [input.ruleId],
        );
        const previous = previousResult.rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Classification rule", input.ruleId);
        const previouslyAffected = await client.query<DatabaseRow>(
          `SELECT DISTINCT source_product_id
           FROM ${classificationObservationReadModelSql} observation
           WHERE active = TRUE AND rule_id = $1`,
          [input.ruleId],
        );

        const referenceResult = await client.query<DatabaseRow>(
          `SELECT value.id
           FROM reference_values value
           WHERE value.id = $1 AND value.type_id = $2 AND value.enabled = TRUE`,
          [input.referenceValueId, previous.reference_type_id],
        );
        if (referenceResult.rows[0] === undefined) throw new EntityNotFoundError("Reference value", input.referenceValueId);

        const conditionsJson = JSON.stringify(input.conditions);
        const unchanged = String(previous.name) === input.name
          && Number(previous.priority) === input.priority
          && JSON.stringify(previous.conditions) === conditionsJson
          && String(previous.reference_value_id) === input.referenceValueId;
        const result = await client.query<DatabaseRow>(
          `UPDATE source_reference_rules
           SET name = $2,
               priority = $3,
               conditions = $4::JSONB,
               reference_value_id = $5,
               revision = CASE WHEN $6::BOOLEAN THEN revision ELSE revision + 1 END,
               updated_by = $7,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [input.ruleId, input.name, input.priority, conditionsJson, input.referenceValueId, unchanged, input.actor],
        );
        const rule = result.rows[0]!;
        if (!unchanged) {
          await client.query(
            `INSERT INTO source_reference_decision_history (
               rule_id, action, previous_value, new_value, actor, reason
             ) VALUES ($1, 'update', $2::JSONB, $3::JSONB, $4, $5)`,
            [input.ruleId, JSON.stringify(previous), JSON.stringify(rule), input.actor, input.reason ?? null],
          );
        }
        const affectedProductCount = unchanged ? 0 : await enqueueProducts(client, [
          ...input.affectedSourceProductIds,
          ...previouslyAffected.rows.map((row) => String(row.source_product_id)),
        ]);
        if (!unchanged) {
          await replaceRuleReviewCoverage(
            client,
            String(rule.id),
            String(rule.revision),
            input.matchedObservationIds,
          );
        }
        await client.query("COMMIT");
        return { ruleId: String(rule.id), revision: String(rule.revision), affectedProductCount };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async setRuleEnabled(input: {
    readonly ruleId: string;
    readonly enabled: boolean;
    readonly actor: string;
    readonly reason?: string;
    readonly affectedSourceProductIds: readonly string[];
    readonly matchedObservationIds: readonly string[];
  }): Promise<{ readonly affectedProductCount: number; readonly revision: string }> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const previousResult = await client.query<DatabaseRow>(
          `SELECT * FROM source_reference_rules WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [input.ruleId],
        );
        const previous = previousResult.rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Classification rule", input.ruleId);
        const previouslyAffected = await client.query<DatabaseRow>(
          `SELECT DISTINCT source_product_id
           FROM ${classificationObservationReadModelSql} observation
           WHERE active = TRUE AND rule_id = $1`,
          [input.ruleId],
        );
        const unchanged = Boolean(previous.enabled) === input.enabled;
        const result = await client.query<DatabaseRow>(
          `UPDATE source_reference_rules
           SET enabled = $2,
               revision = CASE WHEN $3::BOOLEAN THEN revision ELSE revision + 1 END,
               updated_by = $4,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [input.ruleId, input.enabled, unchanged, input.actor],
        );
        const rule = result.rows[0]!;
        if (!unchanged) {
          await client.query(
            `INSERT INTO source_reference_decision_history (
               rule_id, action, previous_value, new_value, actor, reason
             ) VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`,
            [input.ruleId, input.enabled ? "reactivate" : "deactivate", JSON.stringify(previous), JSON.stringify(rule), input.actor, input.reason ?? null],
          );
        }
        if (!unchanged) {
          await replaceRuleReviewCoverage(
            client,
            String(rule.id),
            String(rule.revision),
            input.enabled ? input.matchedObservationIds : [],
          );
        }
        const affectedProductCount = unchanged ? 0 : await enqueueProducts(client, [
          ...input.affectedSourceProductIds,
          ...previouslyAffected.rows.map((row) => String(row.source_product_id)),
        ]);
        await client.query("COMMIT");
        return { revision: String(rule.revision), affectedProductCount };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async deleteRule(input: {
    readonly ruleId: string;
    readonly actor: string;
    readonly reason?: string;
    readonly affectedSourceProductIds: readonly string[];
  }): Promise<{ readonly affectedProductCount: number; readonly revision: string }> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const previousResult = await client.query<DatabaseRow>(
          `SELECT * FROM source_reference_rules
           WHERE id = $1 AND deleted_at IS NULL
           FOR UPDATE`,
          [input.ruleId],
        );
        const previous = previousResult.rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Classification rule", input.ruleId);
        const previouslyAffected = await client.query<DatabaseRow>(
          `SELECT DISTINCT source_product_id
           FROM ${classificationObservationReadModelSql} observation
           WHERE active = TRUE AND rule_id = $1`,
          [input.ruleId],
        );
        const projections = await client.query<DatabaseRow>(
          `SELECT * FROM target_classification_projections
           WHERE rule_id = $1 AND active = TRUE
           FOR UPDATE`,
          [input.ruleId],
        );
        const result = await client.query<DatabaseRow>(
          `UPDATE source_reference_rules
           SET enabled = FALSE,
               deleted_at = NOW(),
               deleted_by = $2,
               revision = revision + 1,
               updated_by = $2,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [input.ruleId, input.actor],
        );
        const rule = result.rows[0]!;
        await client.query(
          `INSERT INTO source_reference_decision_history (
             rule_id, action, previous_value, new_value, actor, reason
           ) VALUES ($1, 'delete', $2::JSONB, $3::JSONB, $4, $5)`,
          [input.ruleId, JSON.stringify(previous), JSON.stringify(rule), input.actor, input.reason ?? null],
        );
        for (const projection of projections.rows) {
          const projectionResult = await client.query<DatabaseRow>(
            `UPDATE target_classification_projections
             SET active = FALSE, revision = revision + 1, updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [projection.id],
          );
          await client.query(
            `INSERT INTO target_classification_projection_history (
               projection_id, action, previous_value, new_value, actor, reason
             ) VALUES ($1, 'deactivate', $2::JSONB, $3::JSONB, $4, $5)`,
            [projection.id, JSON.stringify(projection), JSON.stringify(projectionResult.rows[0]!), input.actor, `Удалено вместе с правилом #${input.ruleId}`],
          );
        }
        const affectedProductCount = await enqueueProducts(client, [
          ...input.affectedSourceProductIds,
          ...previouslyAffected.rows.map((row) => String(row.source_product_id)),
        ]);
        await replaceRuleReviewCoverage(client, String(rule.id), String(rule.revision), []);
        await client.query("COMMIT");
        return { revision: String(rule.revision), affectedProductCount };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  private async saveTargetLink(
    client: SqlClient,
    input: {
      readonly targetLink?: SaveClassificationDecisionInput["targetLink"];
      readonly actor: string;
      readonly reason?: string;
    },
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
    const relatedProjectionChanged = await this.syncRelatedReferenceProjections(
      client,
      targetLink.targetId,
      referenceValueId,
      targetLink.relatedProjectionSyncs ?? [],
      input.actor,
      input.reason,
    );
    return !unchanged || relatedProjectionChanged;
  }

  private async syncRelatedReferenceProjections(
    client: SqlClient,
    targetId: string,
    referenceValueId: string,
    syncs: readonly {
      readonly relationCode: string;
      readonly sourceTargetScope: string;
      readonly targetScope: string;
      readonly dictionaryValueId: string | null;
      readonly metadata: JsonObject;
    }[],
    actor: string,
    reason?: string,
  ): Promise<boolean> {
    let changed = false;
    for (const sync of syncs) {
      const managedResult = await client.query<DatabaseRow>(
        `SELECT * FROM target_reference_projections
         WHERE target_id = $1 AND reference_value_id = $2 AND target_scope = $3
           AND metadata->>'managedBy' = 'target_term_relation'
           AND metadata->>'relationCode' = $4
           AND metadata->>'sourceTargetScope' = $5
         FOR UPDATE`,
        [targetId, referenceValueId, sync.targetScope, sync.relationCode, sync.sourceTargetScope],
      );
      for (const previous of managedResult.rows) {
        if (previous.active !== true || (sync.dictionaryValueId !== null && String(previous.dictionary_value_id) === sync.dictionaryValueId)) continue;
        const deactivated = await client.query<DatabaseRow>(
          `UPDATE target_reference_projections
           SET active = FALSE, revision = revision + 1, updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [previous.id],
        );
        await client.query(
          `INSERT INTO target_reference_projection_history (
             projection_id, action, previous_value, new_value, actor, reason
           ) VALUES ($1, 'deactivate', $2::JSONB, $3::JSONB, $4, $5)`,
          [previous.id, JSON.stringify(previous), JSON.stringify(deactivated.rows[0]!), actor, reason ?? `Связанная метка ${sync.relationCode} изменилась`],
        );
        changed = true;
      }
      if (sync.dictionaryValueId === null) continue;

      const previousResult = await client.query<DatabaseRow>(
        `SELECT * FROM target_reference_projections
         WHERE target_id = $1 AND reference_value_id = $2 AND target_scope = $3 AND dictionary_value_id = $4
         FOR UPDATE`,
        [targetId, referenceValueId, sync.targetScope, sync.dictionaryValueId],
      );
      const previous = previousResult.rows[0];
      if (previous === undefined) {
        const inserted = await client.query<DatabaseRow>(
          `INSERT INTO target_reference_projections (
             target_id, reference_value_id, target_scope, dictionary_value_id, metadata, created_by
           ) VALUES ($1, $2, $3, $4, $5::JSONB, $6) RETURNING *`,
          [targetId, referenceValueId, sync.targetScope, sync.dictionaryValueId, JSON.stringify(sync.metadata), actor],
        );
        const row = inserted.rows[0]!;
        await client.query(
          `INSERT INTO target_reference_projection_history (
             projection_id, action, previous_value, new_value, actor, reason
           ) VALUES ($1, 'create', NULL, $2::JSONB, $3, $4)`,
          [row.id, JSON.stringify(row), actor, reason ?? `Автоматически добавлена связанная метка ${sync.relationCode}`],
        );
        changed = true;
        continue;
      }

      const managed = jsonObject(previous.metadata).managedBy === "target_term_relation";
      const metadataChanged = managed && !sameJson(jsonObject(previous.metadata), sync.metadata);
      if (previous.active === true && !metadataChanged) continue;
      const updated = await client.query<DatabaseRow>(
        `UPDATE target_reference_projections
         SET active = TRUE,
             metadata = CASE WHEN $2::BOOLEAN THEN $3::JSONB ELSE metadata END,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [previous.id, managed, JSON.stringify(sync.metadata)],
      );
      await client.query(
        `INSERT INTO target_reference_projection_history (
           projection_id, action, previous_value, new_value, actor, reason
         ) VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`,
        [previous.id, previous.active === true ? "update" : "reactivate", JSON.stringify(previous), JSON.stringify(updated.rows[0]!), actor, reason ?? `Синхронизирована связанная метка ${sync.relationCode}`],
      );
      changed = true;
    }
    return changed;
  }

  private async previewTargetValueMappingWithClient(
    client: SqlClient,
    input: TargetValueMappingCommand,
  ): Promise<TargetClassificationProjectionPreview> {
    const mappingResult = await client.query<DatabaseRow>(
      `SELECT mapping.*, dictionary.target_id AS dictionary_target_id
       FROM target_value_mappings mapping
       LEFT JOIN target_dictionary_values dictionary ON dictionary.id = $2
       WHERE mapping.id = $1`,
      [input.mappingId, input.dictionaryValueId],
    );
    const mapping = mappingResult.rows[0];
    if (mapping === undefined) throw new EntityNotFoundError("Target value mapping", input.mappingId);
    if (mapping.dictionary_target_id === null || mapping.dictionary_target_id === undefined
      || String(mapping.dictionary_target_id) !== String(mapping.target_id)) {
      throw new EntityNotFoundError("Target dictionary value", input.dictionaryValueId);
    }
    const stats = await client.query<DatabaseRow>(
      `SELECT COUNT(*)::INTEGER AS observation_count,
              COUNT(DISTINCT source_product_id)::INTEGER AS product_count,
              COALESCE(JSONB_AGG(DISTINCT source_product_id::TEXT), '[]'::JSONB) AS source_product_ids
       FROM ${classificationObservationReadModelSql} observation
       WHERE active = TRUE AND status = 'resolved' AND resolved_reference_value_id = $1`,
      [mapping.reference_value_id],
    );
    const examples = await client.query<DatabaseRow>(
      `SELECT product.id AS source_product_id, product.source_key,
              internal.data->>'title' AS title, internal.data->>'sku' AS sku,
              COALESCE((
                SELECT JSONB_AGG(DISTINCT term->>'name')
                FROM target_product_snapshots snapshot,
                     JSONB_ARRAY_ELEMENTS(COALESCE(snapshot.payload->'product'->'taxonomies'->taxonomy.name, '[]'::JSONB)) term
                WHERE snapshot.target_id = $2
                  AND snapshot.source_product_id = product.id
                  AND term ? 'name'
              ), '[]'::JSONB) AS current_terms
       FROM (
         SELECT DISTINCT source_product_id
         FROM ${classificationObservationReadModelSql} observation
         WHERE active = TRUE AND status = 'resolved' AND resolved_reference_value_id = $1
       ) affected
       JOIN source_products product ON product.id = affected.source_product_id
       LEFT JOIN internal_products internal ON internal.source_product_id = product.id
       CROSS JOIN LATERAL (
         SELECT CASE $3
           WHEN 'product.brand' THEN 'pa_brand'
           WHEN 'product.model' THEN 'pa_model'
           WHEN 'product.category' THEN 'product_cat'
           WHEN 'product.tag' THEN 'product_tag'
           WHEN 'product.color' THEN 'pa_tsvet'
           WHEN 'product.material' THEN 'pa_material'
           WHEN 'product.activity' THEN 'pa_vid'
           WHEN 'product.shoe_height' THEN 'pa_shoe_height'
           WHEN 'product.season' THEN 'pa_season'
           ELSE ''
         END AS name
       ) taxonomy
       ORDER BY product.id LIMIT 10`,
      [mapping.reference_value_id, mapping.target_id, mapping.target_scope],
    );
    return {
      observationCount: Number(stats.rows[0]?.observation_count ?? 0),
      productCount: Number(stats.rows[0]?.product_count ?? 0),
      affectedSourceProductIds: stringArray(stats.rows[0]?.source_product_ids),
      examples: examples.rows.map((row) => ({
        sourceProductId: String(row.source_product_id),
        sourceKey: String(row.source_key),
        title: nullableText(row.title),
        sku: nullableText(row.sku),
        currentTerms: stringArray(row.current_terms),
      })),
      duplicate: null,
      cardinalityConflicts: [],
    };
  }

  private async previewTargetProjectionWithClient(
    client: SqlClient,
    input: TargetClassificationProjectionCommand,
    excludeProjectionId = input.excludeProjectionId,
  ): Promise<TargetClassificationProjectionPreview> {
    const resolutionColumn = input.resolutionKind === "mapping" ? "mapping_id" : "rule_id";
    const resolutionTable = input.resolutionKind === "mapping" ? "source_reference_mappings" : "source_reference_rules";
    const resolutionFilter = input.resolutionKind === "mapping"
      ? "observation.mapping_id = $2"
      : "observation.rule_id = $2";
    const resolutionResult = await client.query<DatabaseRow>(
      `SELECT id FROM ${resolutionTable} WHERE id = $1`,
      [input.resolutionId],
    );
    if (resolutionResult.rows[0] === undefined) {
      throw new EntityNotFoundError("Classification resolution", `${input.resolutionKind}/${input.resolutionId}`);
    }

    const duplicateResult = await client.query<DatabaseRow>(
      `SELECT projection.*, dictionary.external_id AS external_value, dictionary.name AS external_label
       FROM target_classification_projections projection
       JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
       WHERE projection.target_id = $1
         AND projection.${resolutionColumn} = $2
         AND projection.target_scope = $3
         AND projection.dictionary_value_id = $4
         AND projection.active = TRUE
         AND ($5::BIGINT IS NULL OR projection.id <> $5)
       LIMIT 1`,
      [input.targetId, input.resolutionId, input.targetScope, input.dictionaryValueId, excludeProjectionId ?? null],
    );

    const stats = await client.query<DatabaseRow>(
      `WITH affected AS (
         SELECT DISTINCT observation.id AS observation_id, observation.source_product_id
         FROM ${classificationObservationReadModelSql} observation
         WHERE observation.active = TRUE
           AND observation.status = 'resolved'
           AND $1::BIGINT IS NOT NULL
           AND ${resolutionFilter}
       )
       SELECT COUNT(*)::INTEGER AS observation_count,
              COUNT(DISTINCT source_product_id)::INTEGER AS product_count,
              COALESCE(JSONB_AGG(DISTINCT source_product_id::TEXT), '[]'::JSONB) AS source_product_ids
       FROM affected`,
      [input.targetId, input.resolutionId],
    );
    const sourceProductIds = stringArray(stats.rows[0]?.source_product_ids);

    const examplesResult = await client.query<DatabaseRow>(
      `WITH affected AS (
         SELECT DISTINCT observation.source_product_id
         FROM ${classificationObservationReadModelSql} observation
         WHERE observation.active = TRUE
           AND observation.status = 'resolved'
           AND ${resolutionFilter}
       )
       SELECT product.id AS source_product_id,
              product.source_key,
              internal.data->>'title' AS title,
              internal.data->>'sku' AS sku,
              COALESCE((
                SELECT JSONB_AGG(DISTINCT term->>'name')
                FROM target_product_snapshots snapshot,
                     JSONB_ARRAY_ELEMENTS(COALESCE(snapshot.payload->'product'->'taxonomies'->taxonomy.name, '[]'::JSONB)) AS term
                WHERE snapshot.target_id = $1
                  AND snapshot.source_product_id = product.id
                  AND term ? 'name'
              ), '[]'::JSONB) AS current_terms
       FROM affected
       JOIN source_products product ON product.id = affected.source_product_id
       LEFT JOIN internal_products internal ON internal.source_product_id = product.id
       CROSS JOIN LATERAL (
         SELECT CASE $3
           WHEN 'product.brand' THEN 'pa_brand'
           WHEN 'product.model' THEN 'pa_model'
           WHEN 'product.category' THEN 'product_cat'
           WHEN 'product.tag' THEN 'product_tag'
           WHEN 'product.color' THEN 'pa_tsvet'
           WHEN 'product.material' THEN 'pa_material'
           WHEN 'product.activity' THEN 'pa_vid'
           WHEN 'product.shoe_height' THEN 'pa_shoe_height'
           WHEN 'product.season' THEN 'pa_season'
           ELSE ''
         END AS name
       ) taxonomy
       ORDER BY product.id
       LIMIT 10`,
      [input.targetId, input.resolutionId, input.targetScope],
    );

    const conflictResult = await client.query<DatabaseRow>(
      `WITH affected AS (
         SELECT DISTINCT observation.source_product_id
         FROM ${classificationObservationReadModelSql} observation
         WHERE observation.active = TRUE
           AND observation.status = 'resolved'
           AND ${resolutionFilter}
       ), existing_outputs AS (
         SELECT observation.source_product_id, target_mapping.dictionary_value_id
         FROM affected
         JOIN ${classificationObservationReadModelSql} observation
           ON observation.source_product_id = affected.source_product_id
          AND observation.active = TRUE
          AND observation.status = 'resolved'
         JOIN target_value_mappings target_mapping
           ON target_mapping.target_id = $1
          AND target_mapping.reference_value_id = observation.resolved_reference_value_id
          AND target_mapping.target_scope = $3
          AND target_mapping.active = TRUE
         UNION ALL
         SELECT observation.source_product_id, projection.dictionary_value_id
         FROM affected
         JOIN ${classificationObservationReadModelSql} observation
           ON observation.source_product_id = affected.source_product_id
          AND observation.active = TRUE
          AND observation.status = 'resolved'
         JOIN target_reference_projections projection
           ON projection.target_id = $1
          AND projection.target_scope = $3
          AND projection.active = TRUE
          AND projection.reference_value_id = observation.resolved_reference_value_id
         UNION ALL
         SELECT observation.source_product_id, projection.dictionary_value_id
         FROM affected
         JOIN ${classificationObservationReadModelSql} observation
           ON observation.source_product_id = affected.source_product_id
          AND observation.active = TRUE
          AND observation.status = 'resolved'
         JOIN target_classification_projections projection
           ON projection.target_id = $1
          AND projection.target_scope = $3
          AND projection.active = TRUE
          AND (projection.mapping_id = observation.mapping_id OR projection.rule_id = observation.rule_id)
          AND ($6::BIGINT IS NULL OR projection.id <> $6)
       )
       SELECT DISTINCT source_product_id
       FROM existing_outputs
       WHERE dictionary_value_id <> $4
         AND $5::TEXT = 'single'
       LIMIT 100`,
      [input.targetId, input.resolutionId, input.targetScope, input.dictionaryValueId, input.targetCardinality, excludeProjectionId ?? null],
    );

    return {
      observationCount: Number(stats.rows[0]?.observation_count ?? 0),
      productCount: Number(stats.rows[0]?.product_count ?? 0),
      affectedSourceProductIds: sourceProductIds,
      examples: examplesResult.rows.map((row) => ({
        sourceProductId: String(row.source_product_id),
        sourceKey: String(row.source_key),
        title: nullableText(row.title),
        sku: nullableText(row.sku),
        currentTerms: stringArray(row.current_terms),
      })),
      duplicate: duplicateResult.rows[0] === undefined ? null : mapTargetClassificationProjection(duplicateResult.rows[0]),
      cardinalityConflicts: conflictResult.rows.map((row) => String(row.source_product_id)),
    };
  }

  private async previewReferenceProjectionWithClient(
    client: SqlClient,
    input: TargetReferenceProjectionCommand,
  ): Promise<TargetClassificationProjectionPreview> {
    const reference = await client.query<DatabaseRow>(
      "SELECT id FROM reference_values WHERE id = $1 AND enabled = TRUE",
      [input.referenceValueId],
    );
    if (reference.rows[0] === undefined) throw new EntityNotFoundError("Internal value", input.referenceValueId);
    const dictionary = await client.query<DatabaseRow>(
      "SELECT id FROM target_dictionary_values WHERE id = $1 AND target_id = $2 AND active = TRUE",
      [input.dictionaryValueId, input.targetId],
    );
    if (dictionary.rows[0] === undefined) throw new EntityNotFoundError("Target dictionary value", input.dictionaryValueId);
    const duplicate = await client.query<DatabaseRow>(
      `SELECT projection.*, dictionary.external_id AS external_value, dictionary.name AS external_label
       FROM target_reference_projections projection
       JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
       WHERE projection.target_id = $1 AND projection.reference_value_id = $2
         AND projection.target_scope = $3 AND projection.dictionary_value_id = $4
         AND projection.active = TRUE`,
      [input.targetId, input.referenceValueId, input.targetScope, input.dictionaryValueId],
    );

    const stats = await client.query<DatabaseRow>(
      `SELECT COUNT(*)::INTEGER AS observation_count,
              COUNT(DISTINCT source_product_id)::INTEGER AS product_count,
              COALESCE(JSONB_AGG(DISTINCT source_product_id::TEXT), '[]'::JSONB) AS source_product_ids
       FROM ${classificationObservationReadModelSql} observation
       WHERE active = TRUE AND status = 'resolved' AND resolved_reference_value_id = $1`,
      [input.referenceValueId],
    );
    const examples = await client.query<DatabaseRow>(
      `SELECT product.id AS source_product_id, product.source_key,
              internal.data->>'title' AS title, internal.data->>'sku' AS sku,
              '[]'::JSONB AS current_terms
       FROM (
         SELECT DISTINCT source_product_id
         FROM ${classificationObservationReadModelSql} observation
         WHERE active = TRUE AND status = 'resolved' AND resolved_reference_value_id = $1
       ) affected
       JOIN source_products product ON product.id = affected.source_product_id
       LEFT JOIN internal_products internal ON internal.source_product_id = product.id
       ORDER BY product.id LIMIT 10`,
      [input.referenceValueId],
    );
    const conflicts = input.targetCardinality === "multiple" ? { rows: [] as DatabaseRow[] } : await client.query<DatabaseRow>(
      `WITH affected AS (
         SELECT DISTINCT source_product_id
         FROM ${classificationObservationReadModelSql} observation
         WHERE active = TRUE AND status = 'resolved' AND resolved_reference_value_id = $2
       ), outputs AS (
         SELECT observation.source_product_id, mapping.dictionary_value_id
         FROM affected
         JOIN ${classificationObservationReadModelSql} observation
           ON observation.source_product_id = affected.source_product_id
          AND observation.active = TRUE AND observation.status = 'resolved'
         JOIN target_value_mappings mapping
           ON mapping.target_id = $1 AND mapping.reference_value_id = observation.resolved_reference_value_id
          AND mapping.target_scope = $3 AND mapping.active = TRUE
         UNION ALL
         SELECT observation.source_product_id, projection.dictionary_value_id
         FROM affected
         JOIN ${classificationObservationReadModelSql} observation
           ON observation.source_product_id = affected.source_product_id
          AND observation.active = TRUE AND observation.status = 'resolved'
         JOIN target_reference_projections projection
           ON projection.target_id = $1 AND projection.reference_value_id = observation.resolved_reference_value_id
          AND projection.target_scope = $3 AND projection.active = TRUE
         UNION ALL
         SELECT observation.source_product_id, projection.dictionary_value_id
         FROM affected
         JOIN ${classificationObservationReadModelSql} observation
           ON observation.source_product_id = affected.source_product_id
          AND observation.active = TRUE AND observation.status = 'resolved'
         JOIN target_classification_projections projection
           ON projection.target_id = $1 AND projection.target_scope = $3 AND projection.active = TRUE
          AND (projection.mapping_id = observation.mapping_id OR projection.rule_id = observation.rule_id)
       )
       SELECT DISTINCT source_product_id FROM outputs WHERE dictionary_value_id <> $4 LIMIT 100`,
      [input.targetId, input.referenceValueId, input.targetScope, input.dictionaryValueId],
    );
    return {
      observationCount: Number(stats.rows[0]?.observation_count ?? 0),
      productCount: Number(stats.rows[0]?.product_count ?? 0),
      affectedSourceProductIds: stringArray(stats.rows[0]?.source_product_ids),
      examples: examples.rows.map((row) => ({
        sourceProductId: String(row.source_product_id), sourceKey: String(row.source_key),
        title: nullableText(row.title), sku: nullableText(row.sku), currentTerms: stringArray(row.current_terms),
      })),
      duplicate: duplicate.rows[0] === undefined ? null : mapTargetReferenceProjection(duplicate.rows[0]),
      cardinalityConflicts: conflicts.rows.map((row) => String(row.source_product_id)),
    };
  }
}
