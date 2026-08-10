import type { EntityId } from "../../../contracts/index.js";
import { EntityNotFoundError } from "../../../core/errors/index.js";
import type {
  ReferenceRepository,
  SaveTargetClassificationProjectionInput,
  TargetClassificationProjectionRecord,
  TargetReferenceProjectionRecord,
  TargetValueMappingRecord,
} from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { mapTargetClassificationProjection, mapTargetReferenceProjection, mapTargetValueMapping, type DatabaseRow } from "./row-mappers.js";

export class PostgresReferenceRepository implements ReferenceRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async resolveTargetValue(targetId: EntityId, referenceValueId: EntityId, targetScope: string): Promise<TargetValueMappingRecord | null> {
    const result = await this.executor.query<DatabaseRow>(
      "SELECT * FROM target_value_mappings WHERE target_id = $1 AND reference_value_id = $2 AND target_scope = $3 AND active = TRUE",
      [targetId, referenceValueId, targetScope],
    );
    return result.rows[0] ? mapTargetValueMapping(result.rows[0]) : null;
  }

  async resolveTargetProjections(
    targetId: EntityId,
    resolutions: readonly { readonly resolutionKind: "mapping" | "rule"; readonly resolutionId: EntityId; readonly referenceId: EntityId }[],
  ): Promise<readonly (TargetClassificationProjectionRecord | TargetReferenceProjectionRecord)[]> {
    if (resolutions.length === 0) return [];
    const [specific, canonical] = await Promise.all([
      this.executor.query<DatabaseRow>(
      `WITH requested AS (
         SELECT resolution_kind, resolution_id
         FROM JSONB_TO_RECORDSET($2::JSONB) AS item(resolution_kind TEXT, resolution_id BIGINT, reference_id BIGINT)
       )
       SELECT DISTINCT projection.*, dictionary.external_id AS external_value,
              dictionary.name AS external_label
       FROM target_classification_projections projection
       JOIN target_dictionary_values dictionary
         ON dictionary.id = projection.dictionary_value_id
        AND dictionary.target_id = projection.target_id
        AND dictionary.active = TRUE
       JOIN requested
         ON (requested.resolution_kind = 'mapping' AND projection.mapping_id = requested.resolution_id)
         OR (requested.resolution_kind = 'rule' AND projection.rule_id = requested.resolution_id)
       WHERE projection.target_id = $1 AND projection.active = TRUE
       ORDER BY projection.id`,
      [targetId, JSON.stringify(resolutions.map((item) => ({ resolution_kind: item.resolutionKind, resolution_id: item.resolutionId, reference_id: item.referenceId })))],
      ),
      this.executor.query<DatabaseRow>(
        `WITH requested AS (
           SELECT DISTINCT reference_id
           FROM JSONB_TO_RECORDSET($2::JSONB) AS item(resolution_kind TEXT, resolution_id BIGINT, reference_id BIGINT)
         )
         SELECT projection.*, dictionary.external_id AS external_value,
                dictionary.name AS external_label
         FROM target_reference_projections projection
         JOIN target_dictionary_values dictionary
           ON dictionary.id = projection.dictionary_value_id
          AND dictionary.target_id = projection.target_id
          AND dictionary.active = TRUE
         JOIN requested ON requested.reference_id = projection.reference_value_id
         WHERE projection.target_id = $1 AND projection.active = TRUE
         ORDER BY projection.id`,
        [targetId, JSON.stringify(resolutions.map((item) => ({ resolution_kind: item.resolutionKind, resolution_id: item.resolutionId, reference_id: item.referenceId })))],
      ),
    ]);
    return [...specific.rows.map(mapTargetClassificationProjection), ...canonical.rows.map(mapTargetReferenceProjection)];
  }

  async saveTargetProjection(input: SaveTargetClassificationProjectionInput): Promise<TargetClassificationProjectionRecord> {
    const resolutionColumn = input.resolutionKind === "mapping" ? "mapping_id" : "rule_id";
    const resolutionTable = input.resolutionKind === "mapping" ? "source_reference_mappings" : "source_reference_rules";
    const conflictPredicate = input.resolutionKind === "mapping" ? "mapping_id IS NOT NULL" : "rule_id IS NOT NULL";
    const result = await this.executor.query<DatabaseRow>(
      `WITH selected_resolution AS (
         SELECT id FROM ${resolutionTable} WHERE id = $2
       ), selected_dictionary AS (
         SELECT id FROM target_dictionary_values
         WHERE id = $4 AND target_id = $1 AND active = TRUE
       ), saved AS (
         INSERT INTO target_classification_projections (
           target_id, ${resolutionColumn}, target_scope, dictionary_value_id,
           metadata, active, revision, created_by
         )
         SELECT $1, selected_resolution.id, $3, selected_dictionary.id,
                '{}'::JSONB, TRUE, 1, $5
         FROM selected_resolution CROSS JOIN selected_dictionary
         ON CONFLICT (target_id, ${resolutionColumn}, target_scope, dictionary_value_id)
           WHERE ${conflictPredicate}
         DO UPDATE SET active = TRUE,
           revision = CASE WHEN target_classification_projections.active THEN target_classification_projections.revision ELSE target_classification_projections.revision + 1 END,
           updated_at = NOW()
         RETURNING *
       )
       SELECT saved.*, dictionary.external_id AS external_value,
              dictionary.name AS external_label
       FROM saved
       JOIN target_dictionary_values dictionary ON dictionary.id = saved.dictionary_value_id`,
      [input.targetId, input.resolutionId, input.targetScope, input.dictionaryValueId, input.actor],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new EntityNotFoundError("Target projection resolution or dictionary value", `${input.resolutionKind}/${input.resolutionId}/${input.dictionaryValueId}`);
    }
    return mapTargetClassificationProjection(row);
  }

  async getTargetMappingRevision(targetId: EntityId): Promise<string> {
    const result = await this.executor.query<DatabaseRow>(
      `SELECT MD5(JSONB_BUILD_OBJECT(
         'mappings', COALESCE((
           SELECT JSONB_AGG(JSONB_BUILD_ARRAY(mapping.id, mapping.reference_value_id, mapping.target_scope,
             mapping.external_value, mapping.external_label, mapping.metadata, mapping.revision, mapping.updated_at) ORDER BY mapping.id)
           FROM target_value_mappings mapping
           WHERE mapping.target_id = $1 AND mapping.active = TRUE
         ), '[]'::JSONB),
         'projections', COALESCE((
           SELECT JSONB_AGG(JSONB_BUILD_ARRAY(projection.id, projection.mapping_id, projection.rule_id,
             projection.target_scope, projection.dictionary_value_id, projection.metadata,
             projection.revision, projection.updated_at, dictionary.external_id, dictionary.updated_at) ORDER BY projection.id)
           FROM target_classification_projections projection
           JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
           WHERE projection.target_id = $1 AND projection.active = TRUE AND dictionary.active = TRUE
         ), '[]'::JSONB),
         'referenceProjections', COALESCE((
           SELECT JSONB_AGG(JSONB_BUILD_ARRAY(projection.id, projection.reference_value_id,
             projection.target_scope, projection.dictionary_value_id, projection.metadata,
             projection.revision, projection.updated_at, dictionary.external_id, dictionary.updated_at) ORDER BY projection.id)
           FROM target_reference_projections projection
           JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
           WHERE projection.target_id = $1 AND projection.active = TRUE AND dictionary.active = TRUE
         ), '[]'::JSONB)
       )::TEXT) AS revision`,
      [targetId],
    );
    return String(result.rows[0]?.revision ?? "");
  }
}
