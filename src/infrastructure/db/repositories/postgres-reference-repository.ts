import type { EntityId } from "../../../contracts/index.js";
import { EntityNotFoundError } from "../../../core/errors/index.js";
import type {
  ReferenceRepository,
  SaveTargetClassificationProjectionInput,
  TargetClassificationProjectionRecord,
  TargetAssignmentRuleRecord,
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
              dictionary.name AS external_label, dictionary.slug AS external_slug
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
                dictionary.name AS external_label, dictionary.slug AS external_slug
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
              dictionary.name AS external_label, dictionary.slug AS external_slug
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
      `SELECT revision::TEXT AS revision
       FROM target_export_revisions
       WHERE target_id = $1`,
      [targetId],
    );
    return String(result.rows[0]?.revision ?? "");
  }

  async listTargetAssignmentRules(targetId: EntityId): Promise<readonly TargetAssignmentRuleRecord[]> {
    const result = await this.executor.query<DatabaseRow>(
      `SELECT rule.*,
              COALESCE((
                SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
                  'conditions', COALESCE((
                    SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
                      'field', condition.field,
                      'operator', condition.operator,
                      'values', CASE WHEN condition.match_set_id IS NULL THEN COALESCE((
                        SELECT JSONB_AGG(inline_value.value ORDER BY inline_value.position)
                        FROM target_assignment_rule_condition_values inline_value
                        WHERE inline_value.condition_id = condition.id
                      ), '[]'::JSONB) ELSE COALESCE((
                        SELECT JSONB_AGG(set_value.value ORDER BY set_value.position)
                        FROM target_assignment_match_set_values set_value
                        WHERE set_value.match_set_id = condition.match_set_id
                      ), '[]'::JSONB) END,
                      'matchSetId', match_set.id::TEXT,
                      'matchSetCode', match_set.code,
                      'matchSetName', match_set.name
                    ) ORDER BY condition.position)
                    FROM target_assignment_rule_conditions condition
                    LEFT JOIN target_assignment_match_sets match_set ON match_set.id = condition.match_set_id
                    WHERE condition.group_id = condition_group.id
                  ), '[]'::JSONB)
                ) ORDER BY condition_group.position)
                FROM target_assignment_rule_condition_groups condition_group
                WHERE condition_group.rule_id = rule.id
              ), '[]'::JSONB) AS condition_groups,
              COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
                'targetScope', action.target_scope,
                'dictionaryValueId', action.dictionary_value_id::TEXT,
                'externalValue', dictionary.external_id,
                'externalLabel', dictionary.name,
                'mode', action.mode
              ) ORDER BY action.id) FILTER (WHERE action.id IS NOT NULL AND dictionary.id IS NOT NULL), '[]'::JSONB) AS actions
       FROM target_assignment_rules rule
       LEFT JOIN target_assignment_rule_actions action ON action.rule_id = rule.id
       LEFT JOIN target_dictionary_values dictionary
         ON dictionary.id = action.dictionary_value_id AND dictionary.active = TRUE
       WHERE rule.target_id = $1 AND rule.enabled = TRUE
       GROUP BY rule.id
       ORDER BY rule.group_code, rule.priority DESC, rule.id`,
      [targetId],
    );
    return result.rows.map((row) => {
      const conditionGroups = row.condition_groups as TargetAssignmentRuleRecord["conditionGroups"];
      return ({
      id: String(row.id),
      targetId: String(row.target_id),
      name: String(row.name),
      groupCode: String(row.group_code),
      priority: Number(row.priority),
      conditionGroups,
      conditions: conditionGroups.flatMap((group) => group.conditions),
      actions: row.actions as TargetAssignmentRuleRecord["actions"],
      enabled: Boolean(row.enabled),
      revision: String(row.revision),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    }); });
  }
}
