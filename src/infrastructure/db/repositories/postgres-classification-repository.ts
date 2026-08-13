import type { EntityId } from "../../../contracts/index.js";
import type {
  ClassificationLookupInput,
  ClassificationMappingMatchRecord,
  ClassificationReferenceTypeRecord,
  ClassificationRepository,
  ClassificationRuleConditionRecord,
  ClassificationRuleRecord,
  SaveProductClassificationInput,
} from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import type { DatabaseRow } from "./row-mappers.js";

function parseConditions(value: unknown): readonly ClassificationRuleConditionRecord[] {
  if (!Array.isArray(value)) throw new TypeError("Classification rule conditions must be an array");
  return value as unknown as readonly ClassificationRuleConditionRecord[];
}

export class PostgresClassificationRepository implements ClassificationRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async listReferenceTypes(typeCodes: readonly string[]): Promise<readonly ClassificationReferenceTypeRecord[]> {
    if (typeCodes.length === 0) return [];
    const result = await this.executor.query<DatabaseRow>(
      "SELECT code, cardinality, allowed_subject_kinds, metadata FROM reference_types WHERE enabled = TRUE AND code = ANY($1::text[])",
      [typeCodes],
    );
    return result.rows.map((row) => ({
      code: String(row.code),
      cardinality: String(row.cardinality) as ClassificationReferenceTypeRecord["cardinality"],
      allowedSubjectKinds: row.allowed_subject_kinds as ClassificationReferenceTypeRecord["allowedSubjectKinds"],
      metadata: row.metadata as ClassificationReferenceTypeRecord["metadata"],
    }));
  }

  async findSourceDecisions(
    sourceId: EntityId,
    inputs: readonly ClassificationLookupInput[],
  ): Promise<readonly ClassificationMappingMatchRecord[]> {
    if (inputs.length === 0) return [];
    const result = await this.executor.query<DatabaseRow>(
      `WITH requested AS (
        SELECT *
        FROM JSONB_TO_RECORDSET($2::JSONB) AS item(
          candidate_key TEXT,
          type_code TEXT,
          scope TEXT,
          normalized_source_value TEXT,
          context_key TEXT
        )
      )
      SELECT
        requested.candidate_key,
        mapping.id AS mapping_id,
        mapping.reference_value_id,
        mapping.status,
        mapping.revision
      FROM requested
      JOIN reference_types type ON type.code = requested.type_code
      JOIN source_reference_mappings mapping
        ON mapping.source_id = $1
        AND mapping.reference_type_id = type.id
        AND mapping.scope = requested.scope
        AND mapping.normalized_source_value = requested.normalized_source_value
        AND mapping.context_key = requested.context_key
        AND mapping.status IN ('confirmed', 'ignored')
      LEFT JOIN reference_values value
        ON value.id = mapping.reference_value_id
        AND value.type_id = type.id
      WHERE mapping.status = 'ignored' OR value.enabled = TRUE`,
      [sourceId, JSON.stringify(inputs.map((input) => ({
        candidate_key: input.candidateKey,
        type_code: input.typeCode,
        scope: input.scope,
        normalized_source_value: input.normalizedSourceValue,
        context_key: input.contextKey,
      })))],
    );
    return result.rows.map((row) => ({
      candidateKey: String(row.candidate_key),
      mappingId: String(row.mapping_id),
      referenceValueId: row.reference_value_id === null || row.reference_value_id === undefined ? null : String(row.reference_value_id),
      status: String(row.status) as ClassificationMappingMatchRecord["status"],
      revision: String(row.revision),
    }));
  }

  async listActiveRules(
    sourceId: EntityId,
    typeCodes: readonly string[],
  ): Promise<readonly ClassificationRuleRecord[]> {
    if (typeCodes.length === 0) return [];
    const result = await this.executor.query<DatabaseRow>(
      `SELECT
        rule.id,
        rule.source_id,
        type.code AS type_code,
        rule.name,
        rule.priority,
        rule.conditions,
        rule.reference_value_id,
        rule.revision
      FROM source_reference_rules rule
      JOIN reference_types type ON type.id = rule.reference_type_id
      JOIN reference_values value
        ON value.id = rule.reference_value_id
        AND value.type_id = type.id
        AND value.enabled = TRUE
      WHERE rule.enabled = TRUE
        AND rule.deleted_at IS NULL
        AND rule.source_id = $1
        AND type.code = ANY($2::text[])
      ORDER BY rule.priority DESC, JSONB_ARRAY_LENGTH(rule.conditions) DESC, rule.id`,
      [sourceId, typeCodes],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      sourceId: String(row.source_id),
      typeCode: String(row.type_code),
      name: String(row.name),
      priority: Number(row.priority),
      conditions: parseConditions(row.conditions),
      referenceValueId: String(row.reference_value_id),
      revision: String(row.revision),
    }));
  }

  async getActiveRuleSetRevision(sourceId: EntityId): Promise<string> {
    const result = await this.executor.query<DatabaseRow>(
      "SELECT revision FROM classification_rule_set_revisions WHERE source_id = $1",
      [sourceId],
    );
    return String(result.rows[0]?.revision ?? "0");
  }

  async listAllActiveRules(sourceId: EntityId): Promise<readonly ClassificationRuleRecord[]> {
    const result = await this.executor.query<DatabaseRow>(
      `SELECT
        rule.id,
        rule.source_id,
        type.code AS type_code,
        rule.name,
        rule.priority,
        rule.conditions,
        rule.reference_value_id,
        rule.revision
      FROM source_reference_rules rule
      JOIN reference_types type ON type.id = rule.reference_type_id
      JOIN reference_values value
        ON value.id = rule.reference_value_id
        AND value.type_id = type.id
        AND value.enabled = TRUE
      WHERE rule.enabled = TRUE
        AND rule.deleted_at IS NULL
        AND rule.source_id = $1
      ORDER BY rule.priority DESC, JSONB_ARRAY_LENGTH(rule.conditions) DESC, rule.id`,
      [sourceId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      sourceId: String(row.source_id),
      typeCode: String(row.type_code),
      name: String(row.name),
      priority: Number(row.priority),
      conditions: parseConditions(row.conditions),
      referenceValueId: String(row.reference_value_id),
      revision: String(row.revision),
    }));
  }

  async saveProductResult(input: SaveProductClassificationInput): Promise<void> {
    const rows = input.observations.map((observation) => ({
      candidate_key: observation.candidate.key,
      type_code: observation.candidate.typeCode,
      scope: observation.candidate.scope,
      subject_kind: observation.candidate.subjectKind,
      subject_key: observation.candidate.subjectKey ?? "",
      source_value: observation.candidate.sourceValue,
      normalized_source_value: observation.normalizedSourceValue,
      context: observation.candidate.context,
      context_key: observation.contextKey,
      evidence: observation.candidate.evidence,
      status: observation.status,
      issue_reason: observation.issueReason,
      resolved_reference_value_id: observation.referenceValueId,
      mapping_id: observation.resolutionKind === "mapping" ? observation.resolutionId : null,
      rule_id: observation.resolutionKind === "rule" ? observation.resolutionId : null,
      resolution_revision: observation.resolutionRevision,
      matched_rule_ids: observation.matchedRuleIds ?? [],
    }));
    const previousContributions = await this.executor.query<DatabaseRow>(
      "SELECT * FROM classification_review_product_contributions($1)",
      [input.sourceProductId],
    );
    await this.executor.query(
      `WITH incoming AS (
         SELECT candidate_key, matched_rule_ids
         FROM JSONB_TO_RECORDSET($2::JSONB) AS item(candidate_key TEXT, matched_rule_ids JSONB)
       )
       DELETE FROM classification_review_rule_coverage coverage
       USING source_product_classification_links observation
       WHERE observation.id = coverage.observation_id
         AND observation.source_product_id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM incoming
           CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(incoming.matched_rule_ids) matched(rule_id)
           WHERE incoming.candidate_key = observation.candidate_key
             AND matched.rule_id::BIGINT = coverage.rule_id
         )`,
      [input.sourceProductId, JSON.stringify(rows)],
    );
    await this.executor.query(
      `WITH incoming AS (
         SELECT candidate_key
         FROM JSONB_TO_RECORDSET($2::JSONB) AS item(candidate_key TEXT)
       )
       UPDATE source_product_classification_links
       SET active = FALSE, updated_at = NOW()
       WHERE source_product_id = $1 AND active = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM incoming WHERE incoming.candidate_key = source_product_classification_links.candidate_key
         )`,
      [input.sourceProductId, JSON.stringify(rows)],
    );

    await this.executor.query(
      `WITH incoming AS (
        SELECT *
        FROM JSONB_TO_RECORDSET($6::JSONB) AS item(
          type_code TEXT,
          scope TEXT,
          normalized_source_value TEXT,
          context JSONB,
          context_key TEXT,
          evidence JSONB
        )
      ), typed AS (
        SELECT incoming.*, type.id AS reference_type_id
        FROM incoming
        JOIN reference_types type ON type.code = incoming.type_code
      ), inserted_candidates AS (
        INSERT INTO classification_candidates (
          source_id,
          reference_type_id,
          scope,
          normalized_source_value,
          context,
          context_key
        )
        SELECT DISTINCT
          $1::BIGINT,
          reference_type_id,
          scope,
          normalized_source_value,
          context,
          context_key
        FROM typed
        ON CONFLICT (
          source_id,
          reference_type_id,
          scope,
          normalized_source_value,
          context_key
        ) DO NOTHING
        RETURNING id
      ), inserted_evidence AS (
        INSERT INTO source_product_classification_evidence (
          source_product_id,
          evidence_hash,
          evidence
        )
        SELECT DISTINCT
          $2::BIGINT,
          ENCODE(DIGEST(evidence::TEXT, 'sha256'), 'hex'),
          evidence
        FROM incoming
        ON CONFLICT (source_product_id, evidence_hash) DO NOTHING
        RETURNING id
      )
      INSERT INTO source_product_classification_states (
        source_product_id,
        processor_version,
        classifier_version,
        classification_fingerprint
      ) VALUES ($2::BIGINT, $3, $4, $5)
      ON CONFLICT (source_product_id) DO UPDATE SET
        processor_version = EXCLUDED.processor_version,
        classifier_version = EXCLUDED.classifier_version,
        classification_fingerprint = EXCLUDED.classification_fingerprint,
        updated_at = NOW()`,
      [input.sourceId, input.sourceProductId, input.processorVersion, input.classifierVersion, input.fingerprint, JSON.stringify(rows)],
    );

    if (rows.length > 0) await this.executor.query(
      `WITH incoming AS (
        SELECT *
        FROM JSONB_TO_RECORDSET($3::JSONB) AS item(
          candidate_key TEXT,
          type_code TEXT,
          scope TEXT,
          subject_kind TEXT,
          subject_key TEXT,
          source_value TEXT,
          normalized_source_value TEXT,
          context JSONB,
          context_key TEXT,
          evidence JSONB,
          status TEXT,
          issue_reason TEXT,
          resolved_reference_value_id BIGINT,
          mapping_id BIGINT,
          rule_id BIGINT,
          resolution_revision BIGINT,
          matched_rule_ids JSONB
        )
      ), typed AS (
        SELECT
          incoming.*,
          type.id AS reference_type_id,
          candidate.id AS candidate_id,
          evidence_record.id AS evidence_id
        FROM incoming
        JOIN reference_types type ON type.code = incoming.type_code
        JOIN classification_candidates candidate
          ON candidate.source_id = $1::BIGINT
         AND candidate.reference_type_id = type.id
         AND candidate.scope = incoming.scope
         AND candidate.normalized_source_value = incoming.normalized_source_value
         AND candidate.context_key = incoming.context_key
         AND candidate.context = incoming.context
        JOIN source_product_classification_evidence evidence_record
          ON evidence_record.source_product_id = $2::BIGINT
         AND evidence_record.evidence_hash = ENCODE(DIGEST(incoming.evidence::TEXT, 'sha256'), 'hex')
         AND evidence_record.evidence = incoming.evidence
      ), upserted AS (
        INSERT INTO source_product_classification_links (
          source_product_id,
          candidate_key,
          candidate_id,
          evidence_id,
          subject_kind,
          subject_key,
          source_value,
          status,
          issue_reason,
          resolved_reference_value_id,
          mapping_id,
          rule_id,
          resolution_revision,
          active
        )
        SELECT
          $2::BIGINT,
          candidate_key,
          candidate_id,
          evidence_id,
          subject_kind,
          subject_key,
          source_value,
          status,
          issue_reason,
          resolved_reference_value_id,
          mapping_id,
          rule_id,
          resolution_revision,
          TRUE
        FROM typed
        ON CONFLICT (source_product_id, candidate_key) DO UPDATE SET
          candidate_id = EXCLUDED.candidate_id,
          evidence_id = EXCLUDED.evidence_id,
          subject_kind = EXCLUDED.subject_kind,
          subject_key = EXCLUDED.subject_key,
          source_value = EXCLUDED.source_value,
          status = EXCLUDED.status,
          issue_reason = EXCLUDED.issue_reason,
          resolved_reference_value_id = EXCLUDED.resolved_reference_value_id,
          mapping_id = EXCLUDED.mapping_id,
          rule_id = EXCLUDED.rule_id,
          resolution_revision = EXCLUDED.resolution_revision,
          active = TRUE,
          last_seen_at = NOW(),
          updated_at = NOW()
        WHERE (
          source_product_classification_links.candidate_id,
          source_product_classification_links.evidence_id,
          source_product_classification_links.subject_kind,
          source_product_classification_links.subject_key,
          source_product_classification_links.source_value,
          source_product_classification_links.status,
          source_product_classification_links.issue_reason,
          source_product_classification_links.resolved_reference_value_id,
          source_product_classification_links.mapping_id,
          source_product_classification_links.rule_id,
          source_product_classification_links.resolution_revision,
          source_product_classification_links.active
        ) IS DISTINCT FROM (
          EXCLUDED.candidate_id,
          EXCLUDED.evidence_id,
          EXCLUDED.subject_kind,
          EXCLUDED.subject_key,
          EXCLUDED.source_value,
          EXCLUDED.status,
          EXCLUDED.issue_reason,
          EXCLUDED.resolved_reference_value_id,
          EXCLUDED.mapping_id,
          EXCLUDED.rule_id,
          EXCLUDED.resolution_revision,
          TRUE
        )
        RETURNING id
      ), selected_observations AS (
        SELECT observation.id, incoming.candidate_key, observation.status
        FROM incoming
        JOIN source_product_classification_links observation
          ON observation.source_product_id = $2::BIGINT
         AND observation.candidate_key = incoming.candidate_key
      )
      INSERT INTO classification_review_rule_coverage (
        observation_id, rule_id, rule_revision
      )
      SELECT selected_observations.id, rule.id, rule.revision
      FROM selected_observations
      JOIN incoming ON incoming.candidate_key = selected_observations.candidate_key
      CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(incoming.matched_rule_ids) matched(rule_id)
      JOIN source_reference_rules rule
        ON rule.id = matched.rule_id::BIGINT
       AND rule.enabled = TRUE
       AND rule.deleted_at IS NULL
      WHERE selected_observations.status IN ('unresolved', 'ambiguous')
      ON CONFLICT (observation_id, rule_id) DO UPDATE SET
        rule_revision = EXCLUDED.rule_revision,
        updated_at = NOW()
      WHERE classification_review_rule_coverage.rule_revision IS DISTINCT FROM EXCLUDED.rule_revision`,
      [input.sourceId, input.sourceProductId, JSON.stringify(rows)],
    );

    const currentContributions = await this.executor.query<DatabaseRow>(
      "SELECT * FROM classification_review_product_contributions($1)",
      [input.sourceProductId],
    );
    await this.executor.query(
      "SELECT apply_classification_review_product_contributions($1::JSONB, $2::JSONB)",
      [JSON.stringify(previousContributions.rows), JSON.stringify(currentContributions.rows)],
    );
  }
}
