import type { RulesV2LegacyImportResult, RuleV2OriginKind } from "../../repositories/index.js";
import type { SqlClient, SqlPool } from "./sql-executor.js";
import type { DatabaseRow } from "./repositories/row-mappers.js";
import { IntegrationContractError } from "../../core/errors/index.js";

const columns = `(source_id, target_id, name, group_code, priority, status, condition_groups, actions,
  selector_field, selector_operator, selector_values_normalized, origin_kind, origin_id, origin_revision,
  origin_payload, created_by)`;

function upsert(selectSql: string): string {
  return `INSERT INTO rules_v2 ${columns}
${selectSql}
ON CONFLICT (origin_kind, origin_id) WHERE origin_id IS NOT NULL DO UPDATE SET
  source_id = EXCLUDED.source_id,
  target_id = EXCLUDED.target_id,
  name = EXCLUDED.name,
  group_code = EXCLUDED.group_code,
  priority = EXCLUDED.priority,
  status = EXCLUDED.status,
  condition_groups = EXCLUDED.condition_groups,
  actions = EXCLUDED.actions,
  selector_field = EXCLUDED.selector_field,
  selector_operator = EXCLUDED.selector_operator,
  selector_values_normalized = EXCLUDED.selector_values_normalized,
  origin_revision = EXCLUDED.origin_revision,
  origin_payload = EXCLUDED.origin_payload,
  revision = rules_v2.revision + 1,
  updated_at = NOW()
WHERE rules_v2.origin_payload->>'manualOverride' IS DISTINCT FROM 'true' AND ROW(
  rules_v2.source_id, rules_v2.target_id, rules_v2.name, rules_v2.group_code, rules_v2.priority,
  rules_v2.status, rules_v2.condition_groups, rules_v2.actions, rules_v2.selector_field,
  rules_v2.selector_operator, rules_v2.selector_values_normalized, rules_v2.origin_revision,
  rules_v2.origin_payload
) IS DISTINCT FROM ROW(
  EXCLUDED.source_id, EXCLUDED.target_id, EXCLUDED.name, EXCLUDED.group_code, EXCLUDED.priority,
  EXCLUDED.status, EXCLUDED.condition_groups, EXCLUDED.actions, EXCLUDED.selector_field,
  EXCLUDED.selector_operator, EXCLUDED.selector_values_normalized, EXCLUDED.origin_revision,
  EXCLUDED.origin_payload
)`;
}

const contextGroupsSql = `COALESCE((
  SELECT JSONB_AGG(JSONB_BUILD_OBJECT('conditions', JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
    'field', 'candidate.' || type.code || '.context.' || context_entry.key,
    'operator', CASE WHEN JSONB_TYPEOF(context_entry.value) = 'array' THEN 'one_of' ELSE 'equals' END,
    'values', CASE WHEN JSONB_TYPEOF(context_entry.value) = 'array' THEN COALESCE((
      SELECT JSONB_AGG(item.value ORDER BY item.ordinality)
      FROM JSONB_ARRAY_ELEMENTS_TEXT(context_entry.value) WITH ORDINALITY item(value, ordinality)
    ), '[]'::JSONB) ELSE JSONB_BUILD_ARRAY(context_entry.value #>> '{}') END
  ))) ORDER BY context_entry.key)
  FROM JSONB_EACH(mapping.context) context_entry
  WHERE context_entry.value <> 'null'::JSONB
), '[]'::JSONB)`;

const translatedRuleGroupsSql = `COALESCE((
  SELECT JSONB_AGG(JSONB_BUILD_OBJECT('conditions', JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
    'field', 'candidate.' || type.code || '.' || (condition.value->>'field'),
    'operator', condition.value->>'operator',
    'values', JSONB_BUILD_ARRAY(condition.value->>'value')
  ))) ORDER BY condition.ordinality)
  FROM JSONB_ARRAY_ELEMENTS(rule.conditions) WITH ORDINALITY condition(value, ordinality)
), '[]'::JSONB)`;

const exactMappingsSql = upsert(`SELECT
  mapping.source_id,
  NULL::BIGINT,
  'Точное сопоставление: ' || type.name || ' · ' || mapping.source_value,
  'classification_exact',
  1000000,
  CASE WHEN mapping.status = 'ignored' OR value.enabled THEN 'shadow' ELSE 'disabled' END,
  JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT('conditions', JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
    'field', 'candidate.' || type.code || '.sourceValue',
    'operator', 'equals',
    'values', JSONB_BUILD_ARRAY(mapping.source_value)
  )))) || ${contextGroupsSql},
  JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
    'kind', 'resolve_reference',
    'referenceType', type.code,
    'referenceValueId', value.id::TEXT,
    'referenceValueCode', value.code,
    'referenceValueName', value.name,
    'resolutionStatus', mapping.status
  )),
  'candidate.' || type.code || '.sourceValue',
  'equals',
  ARRAY[mapping.normalized_source_value],
  'exact_mapping',
  mapping.id,
  mapping.revision,
  JSONB_BUILD_OBJECT(
    'scope', mapping.scope,
    'sourceValue', mapping.source_value,
    'normalizedSourceValue', mapping.normalized_source_value,
    'context', mapping.context,
    'contextKey', mapping.context_key,
    'method', mapping.method,
    'decisionReason', mapping.decision_reason
  ),
  $1
FROM source_reference_mappings mapping
JOIN reference_types type ON type.id = mapping.reference_type_id
LEFT JOIN reference_values value ON value.id = mapping.reference_value_id`);

const classificationRulesSql = upsert(`WITH prepared AS (
  SELECT rule.*, type.code AS type_code, type.name AS type_name, value.code AS value_code,
    value.name AS value_name, value.enabled AS value_enabled, ${translatedRuleGroupsSql} AS translated_groups
  FROM source_reference_rules rule
  JOIN reference_types type ON type.id = rule.reference_type_id
  JOIN reference_values value ON value.id = rule.reference_value_id
  WHERE JSONB_ARRAY_LENGTH(rule.conditions) > 0
)
SELECT
  rule.source_id,
  NULL::BIGINT,
  rule.name,
  'classification_rule',
  rule.priority,
  CASE WHEN rule.enabled AND rule.deleted_at IS NULL AND rule.value_enabled THEN 'shadow' ELSE 'disabled' END,
  rule.translated_groups,
  JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
    'kind', 'resolve_reference',
    'referenceType', rule.type_code,
    'referenceValueId', rule.reference_value_id::TEXT,
    'referenceValueCode', rule.value_code,
    'referenceValueName', rule.value_name,
    'resolutionStatus', 'confirmed'
  )),
  rule.translated_groups #>> '{0,conditions,0,field}',
  rule.translated_groups #>> '{0,conditions,0,operator}',
  ARRAY[LOWER(BTRIM(rule.translated_groups #>> '{0,conditions,0,values,0}'))],
  'classification_rule',
  rule.id,
  rule.revision,
  JSONB_BUILD_OBJECT(
    'conditions', rule.conditions,
    'enabled', rule.enabled,
    'deletedAt', rule.deleted_at,
    'createdBy', rule.created_by,
    'updatedBy', rule.updated_by
  ),
  $1
FROM prepared rule`);

const targetMappingsSql = upsert(`SELECT
  NULL::BIGINT,
  mapping.target_id,
  'Связь с WordPress: ' || type.name || ' · ' || value.name,
  'target_mapping',
  100,
  CASE WHEN mapping.active THEN 'shadow' ELSE 'disabled' END,
  JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT('conditions', JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
    'field', 'resolved.' || type.code,
    'operator', 'equals',
    'values', JSONB_BUILD_ARRAY(mapping.reference_value_id::TEXT)
  )))),
  JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
    'kind', 'assign_target_term',
    'targetScope', mapping.target_scope,
    'dictionaryValueId', mapping.dictionary_value_id::TEXT,
    'externalValue', mapping.external_value,
    'externalLabel', mapping.external_label,
    'mode', 'replace'
  )),
  'resolved.' || type.code,
  'equals',
  ARRAY[mapping.reference_value_id::TEXT],
  'target_mapping',
  mapping.id,
  mapping.revision,
  JSONB_BUILD_OBJECT(
    'referenceValueId', mapping.reference_value_id::TEXT,
    'referenceValueCode', value.code,
    'targetScope', mapping.target_scope,
    'metadata', mapping.metadata,
    'active', mapping.active
  ),
  $1
FROM target_value_mappings mapping
JOIN reference_values value ON value.id = mapping.reference_value_id
JOIN reference_types type ON type.id = value.type_id`);

const classificationProjectionsSql = upsert(`WITH mapping_projection AS (
  SELECT projection.*, mapping.source_id, type.code AS type_code,
    JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT('conditions', JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
      'field', 'candidate.' || type.code || '.sourceValue',
      'operator', 'equals',
      'values', JSONB_BUILD_ARRAY(mapping.source_value)
    )))) || ${contextGroupsSql} AS translated_groups,
    'candidate.' || type.code || '.sourceValue' AS selector_field,
    'equals'::TEXT AS selector_operator,
    ARRAY[mapping.normalized_source_value] AS selector_values,
    1000000 AS source_priority,
    JSONB_BUILD_OBJECT('mappingId', mapping.id::TEXT, 'ruleId', NULL) AS source_origin
  FROM target_classification_projections projection
  JOIN source_reference_mappings mapping ON mapping.id = projection.mapping_id
  JOIN reference_types type ON type.id = mapping.reference_type_id
), rule_projection AS (
  SELECT projection.*, rule.source_id, type.code AS type_code,
    ${translatedRuleGroupsSql} AS translated_groups,
    'candidate.' || type.code || '.' || (rule.conditions->0->>'field') AS selector_field,
    rule.conditions->0->>'operator' AS selector_operator,
    ARRAY[LOWER(BTRIM(rule.conditions->0->>'value'))] AS selector_values,
    rule.priority AS source_priority,
    JSONB_BUILD_OBJECT('mappingId', NULL, 'ruleId', rule.id::TEXT) AS source_origin
  FROM target_classification_projections projection
  JOIN source_reference_rules rule ON rule.id = projection.rule_id
  JOIN reference_types type ON type.id = rule.reference_type_id
  WHERE JSONB_ARRAY_LENGTH(rule.conditions) > 0
), prepared AS (
  SELECT * FROM mapping_projection
  UNION ALL
  SELECT * FROM rule_projection
)
SELECT
  projection.source_id,
  projection.target_id,
  'Точная проекция WordPress #' || projection.id::TEXT,
  'classification_projection',
  projection.source_priority,
  CASE WHEN projection.active THEN 'shadow' ELSE 'disabled' END,
  projection.translated_groups,
  JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
    'kind', 'assign_target_term',
    'targetScope', projection.target_scope,
    'dictionaryValueId', projection.dictionary_value_id::TEXT,
    'externalValue', dictionary.external_id,
    'externalLabel', dictionary.name,
    'mode', 'add'
  )),
  projection.selector_field,
  projection.selector_operator,
  projection.selector_values,
  'classification_projection',
  projection.id,
  projection.revision,
  JSONB_BUILD_OBJECT(
    'sourceOrigin', projection.source_origin,
    'targetScope', projection.target_scope,
    'dictionaryValueId', projection.dictionary_value_id::TEXT,
    'metadata', projection.metadata,
    'active', projection.active
  ),
  $1
FROM prepared projection
JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id`);

const referenceProjectionsSql = upsert(`SELECT
  NULL::BIGINT,
  projection.target_id,
  'Проекция WordPress: ' || type.name || ' · ' || value.name,
  'reference_projection',
  200,
  CASE WHEN projection.active THEN 'shadow' ELSE 'disabled' END,
  JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT('conditions', JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
    'field', 'resolved.' || type.code,
    'operator', 'equals',
    'values', JSONB_BUILD_ARRAY(projection.reference_value_id::TEXT)
  )))),
  JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
    'kind', 'assign_target_term',
    'targetScope', projection.target_scope,
    'dictionaryValueId', projection.dictionary_value_id::TEXT,
    'externalValue', dictionary.external_id,
    'externalLabel', dictionary.name,
    'mode', 'add'
  )),
  'resolved.' || type.code,
  'equals',
  ARRAY[projection.reference_value_id::TEXT],
  'reference_projection',
  projection.id,
  projection.revision,
  JSONB_BUILD_OBJECT(
    'referenceValueId', projection.reference_value_id::TEXT,
    'referenceValueCode', value.code,
    'targetScope', projection.target_scope,
    'dictionaryValueId', projection.dictionary_value_id::TEXT,
    'metadata', projection.metadata,
    'active', projection.active
  ),
  $1
FROM target_reference_projections projection
JOIN reference_values value ON value.id = projection.reference_value_id
JOIN reference_types type ON type.id = value.type_id
JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id`);

const conditionGroupsSql = `COALESCE((
  SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
    'conditions', COALESCE((
      SELECT JSONB_AGG(JSONB_STRIP_NULLS(JSONB_BUILD_OBJECT(
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
      )) ORDER BY condition.position)
      FROM target_assignment_rule_conditions condition
      LEFT JOIN target_assignment_match_sets match_set ON match_set.id = condition.match_set_id
      WHERE condition.group_id = condition_group.id
    ), '[]'::JSONB)
  ) ORDER BY condition_group.position)
  FROM target_assignment_rule_condition_groups condition_group
  WHERE condition_group.rule_id = rule.id
), '[]'::JSONB)`;

const targetAssignmentRulesSql = upsert(`WITH prepared AS (
  SELECT rule.*, ${conditionGroupsSql} AS translated_groups,
    COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
      'kind', 'assign_target_term',
      'targetScope', action.target_scope,
      'dictionaryValueId', action.dictionary_value_id::TEXT,
      'externalValue', dictionary.external_id,
      'externalLabel', dictionary.name,
      'mode', action.mode
    ) ORDER BY action.id)
    FROM target_assignment_rule_actions action
    JOIN target_dictionary_values dictionary ON dictionary.id = action.dictionary_value_id
    WHERE action.rule_id = rule.id), '[]'::JSONB) AS translated_actions
  FROM target_assignment_rules rule
)
SELECT
  NULL::BIGINT,
  rule.target_id,
  rule.name,
  rule.group_code,
  rule.priority,
  CASE WHEN rule.enabled THEN 'shadow' ELSE 'disabled' END,
  rule.translated_groups,
  rule.translated_actions,
  rule.translated_groups #>> '{0,conditions,0,field}',
  rule.translated_groups #>> '{0,conditions,0,operator}',
  ARRAY(SELECT LOWER(BTRIM(item.value))
    FROM JSONB_ARRAY_ELEMENTS_TEXT(rule.translated_groups #> '{0,conditions,0,values}') item(value)),
  'target_assignment_rule',
  rule.id,
  rule.revision,
  JSONB_BUILD_OBJECT(
    'conditionGroups', rule.translated_groups,
    'actions', rule.translated_actions,
    'enabled', rule.enabled,
    'createdBy', rule.created_by
  ),
  $1
FROM prepared rule
WHERE JSONB_ARRAY_LENGTH(rule.translated_groups) > 0
  AND JSONB_ARRAY_LENGTH(rule.translated_actions) > 0`);

const importStatements = [
  exactMappingsSql,
  classificationRulesSql,
  targetMappingsSql,
  classificationProjectionsSql,
  referenceProjectionsSql,
  targetAssignmentRulesSql,
] as const;

const importedKinds = [
  "exact_mapping",
  "classification_rule",
  "target_mapping",
  "classification_projection",
  "reference_projection",
  "target_assignment_rule",
] as const satisfies readonly Exclude<RuleV2OriginKind, "native">[];

async function importCounts(client: SqlClient): Promise<RulesV2LegacyImportResult> {
  const result = await client.query<DatabaseRow>(
    `SELECT origin_kind, COUNT(*)::INTEGER AS amount
     FROM rules_v2 WHERE origin_kind <> 'native' GROUP BY origin_kind`,
  );
  const counts = Object.fromEntries(importedKinds.map((kind) => [kind, 0])) as Record<(typeof importedKinds)[number], number>;
  for (const row of result.rows) counts[row.origin_kind as (typeof importedKinds)[number]] = Number(row.amount);
  return { counts, total: Object.values(counts).reduce((sum, amount) => sum + amount, 0) };
}

export class RulesV2LegacyImporter {
  constructor(private readonly pool: SqlPool) {}

  async sync(actor: string): Promise<RulesV2LegacyImportResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(193700, 2)");
      const unsupported = await client.query<DatabaseRow>(`SELECT id::TEXT FROM target_assignment_rules rule
        WHERE rule.enabled = TRUE AND (
          NOT EXISTS (SELECT 1 FROM target_assignment_rule_condition_groups groups WHERE groups.rule_id = rule.id)
          OR NOT EXISTS (SELECT 1 FROM target_assignment_rule_actions actions WHERE actions.rule_id = rule.id)
        ) LIMIT 1`);
      if (unsupported.rows.length > 0) throw new IntegrationContractError(`Cannot import actionless or unconditional legacy assignment ${unsupported.rows[0]!.id}`);
      for (const statement of importStatements) await client.query(statement, [actor]);
      await client.query(`WITH surviving AS (
        SELECT 'exact_mapping'::TEXT AS kind, id FROM source_reference_mappings
        UNION ALL SELECT 'classification_rule', id FROM source_reference_rules WHERE JSONB_ARRAY_LENGTH(conditions) > 0
        UNION ALL SELECT 'target_mapping', id FROM target_value_mappings
        UNION ALL SELECT 'classification_projection', id FROM target_classification_projections
        UNION ALL SELECT 'reference_projection', id FROM target_reference_projections
        UNION ALL SELECT 'target_assignment_rule', id FROM target_assignment_rules
      ), changed AS (
        UPDATE rules_v2 rule SET status = 'disabled', revision = revision + 1, updated_at = NOW(),
          origin_payload = origin_payload || '{"migrationSourceMissing":true}'::JSONB
        WHERE rule.origin_kind <> 'native' AND rule.status <> 'disabled'
          AND rule.origin_payload->>'manualOverride' IS DISTINCT FROM 'true'
          AND NOT EXISTS (SELECT 1 FROM surviving WHERE surviving.kind = rule.origin_kind AND surviving.id = rule.origin_id)
        RETURNING rule.*
      ) INSERT INTO rules_v2_history (rule_id, action, previous_value, new_value, actor, reason)
        SELECT id, 'status', NULL, TO_JSONB(changed), $1, 'Исходная запись удалена; копия выключена при синхронизации'
        FROM changed`, [actor]);
      const result = await importCounts(client);
      await client.query(
        "INSERT INTO rules_v2_import_runs (actor, counts) VALUES ($1, $2::JSONB)",
        [actor, JSON.stringify({ ...result.counts, total: result.total })],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
