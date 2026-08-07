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
        AND (rule.source_id IS NULL OR rule.source_id = $1)
        AND type.code = ANY($2::text[])
      ORDER BY rule.priority DESC, JSONB_ARRAY_LENGTH(rule.conditions) DESC, rule.id`,
      [sourceId, typeCodes],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      sourceId: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
      typeCode: String(row.type_code),
      name: String(row.name),
      priority: Number(row.priority),
      conditions: parseConditions(row.conditions),
      referenceValueId: String(row.reference_value_id),
      revision: String(row.revision),
    }));
  }

  async saveProductResult(input: SaveProductClassificationInput): Promise<void> {
    await this.executor.query(
      `UPDATE source_reference_observations
       SET active = FALSE, updated_at = NOW()
       WHERE source_product_id = $1 AND active = TRUE`,
      [input.sourceProductId],
    );
    if (input.observations.length === 0) return;

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
    }));

    await this.executor.query(
      `WITH incoming AS (
        SELECT *
        FROM JSONB_TO_RECORDSET($5::JSONB) AS item(
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
          resolution_revision BIGINT
        )
      ), typed AS (
        SELECT incoming.*, type.id AS reference_type_id
        FROM incoming
        JOIN reference_types type ON type.code = incoming.type_code
      )
      INSERT INTO source_reference_observations (
        source_id,
        source_product_id,
        candidate_key,
        reference_type_id,
        scope,
        subject_kind,
        subject_key,
        source_value,
        normalized_source_value,
        context,
        context_key,
        evidence,
        status,
        issue_reason,
        resolved_reference_value_id,
        mapping_id,
        rule_id,
        resolution_revision,
        classifier_version,
        classification_fingerprint,
        active
      )
      SELECT
        $1,
        $2,
        candidate_key,
        reference_type_id,
        scope,
        subject_kind,
        subject_key,
        source_value,
        normalized_source_value,
        context,
        context_key,
        evidence,
        status,
        issue_reason,
        resolved_reference_value_id,
        mapping_id,
        rule_id,
        resolution_revision,
        $3,
        $4,
        TRUE
      FROM typed
      ON CONFLICT (source_product_id, candidate_key) DO UPDATE SET
        source_id = EXCLUDED.source_id,
        reference_type_id = EXCLUDED.reference_type_id,
        scope = EXCLUDED.scope,
        subject_kind = EXCLUDED.subject_kind,
        subject_key = EXCLUDED.subject_key,
        source_value = EXCLUDED.source_value,
        normalized_source_value = EXCLUDED.normalized_source_value,
        context = EXCLUDED.context,
        context_key = EXCLUDED.context_key,
        evidence = EXCLUDED.evidence,
        status = EXCLUDED.status,
        issue_reason = EXCLUDED.issue_reason,
        resolved_reference_value_id = EXCLUDED.resolved_reference_value_id,
        mapping_id = EXCLUDED.mapping_id,
        rule_id = EXCLUDED.rule_id,
        resolution_revision = EXCLUDED.resolution_revision,
        classifier_version = EXCLUDED.classifier_version,
        classification_fingerprint = EXCLUDED.classification_fingerprint,
        active = TRUE,
        last_seen_at = NOW(),
        updated_at = NOW()`,
      [input.sourceId, input.sourceProductId, input.classifierVersion, input.fingerprint, JSON.stringify(rows)],
    );
  }
}
