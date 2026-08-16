import { EntityNotFoundError, IntegrationContractError } from "../../../core/errors/index.js";
import type {
  TargetAssignmentConditionRecord,
  TargetAssignmentHistoryRecord,
  TargetAssignmentMatchSetDraft,
  TargetAssignmentMatchSetOverlap,
  TargetAssignmentMatchSetRecord,
  TargetAssignmentRuleDraft,
  TargetAssignmentRulePreview,
  TargetAssignmentRuleRecord,
  TargetAssignmentRuleRepository,
} from "../../../repositories/index.js";
import type { SqlClient, SqlPool } from "../sql-executor.js";
import type { DatabaseRow } from "./row-mappers.js";

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalize(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizePhrase(value: string): string {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:wmns|womens|mens)\b/gu, " ").replace(/\s+/gu, " ").trim();
}

function postgresRegex(value: string): string {
  return value.replaceAll("\\b", "\\y");
}

function uniqueValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [value.trim()];
  });
}

function mapRule(row: DatabaseRow): TargetAssignmentRuleRecord {
  const conditionGroups = row.condition_groups as TargetAssignmentRuleRecord["conditionGroups"];
  return {
    id: String(row.id), targetId: String(row.target_id), name: String(row.name), groupCode: String(row.group_code),
    priority: Number(row.priority), conditionGroups, conditions: conditionGroups.flatMap((group) => group.conditions),
    actions: row.actions as TargetAssignmentRuleRecord["actions"], enabled: Boolean(row.enabled), revision: String(row.revision),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}

function mapMatchSet(row: DatabaseRow): TargetAssignmentMatchSetRecord {
  return {
    id: String(row.id), targetId: String(row.target_id), code: String(row.code), name: String(row.name),
    values: row.values as readonly string[], revision: String(row.revision),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}

async function withClient<Result>(pool: SqlPool, callback: (client: SqlClient) => Promise<Result>): Promise<Result> {
  const client = await pool.connect();
  try { return await callback(client); } finally { client.release(); }
}

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

const selectedRulesSql = `SELECT rule.*,
  ${conditionGroupsSql} AS condition_groups,
  COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
    'targetScope', action.target_scope, 'dictionaryValueId', action.dictionary_value_id::TEXT,
    'externalValue', dictionary.external_id, 'externalLabel', dictionary.name, 'mode', action.mode
  ) ORDER BY action.id) FILTER (WHERE action.id IS NOT NULL AND dictionary.id IS NOT NULL), '[]'::JSONB) AS actions
FROM target_assignment_rules rule
LEFT JOIN target_assignment_rule_actions action ON action.rule_id = rule.id
LEFT JOIN target_dictionary_values dictionary ON dictionary.id = action.dictionary_value_id
WHERE rule.target_id = $1 AND ($2::BIGINT IS NULL OR rule.id = $2)
GROUP BY rule.id
ORDER BY rule.group_code, rule.priority DESC, rule.id`;

async function conditionValues(client: SqlClient, targetId: string, condition: TargetAssignmentConditionRecord): Promise<readonly string[]> {
  if (condition.matchSetId === undefined || condition.matchSetId === null) return uniqueValues(condition.values);
  const result = await client.query<DatabaseRow>(
    `SELECT value.value
     FROM target_assignment_match_sets match_set
     JOIN target_assignment_match_set_values value ON value.match_set_id = match_set.id
     WHERE match_set.id = $1 AND match_set.target_id = $2
     ORDER BY value.position`,
    [condition.matchSetId, targetId],
  );
  if (result.rows.length === 0) throw new EntityNotFoundError("Target assignment match set", condition.matchSetId);
  return result.rows.map((row) => String(row.value));
}

function conditionProductIdsSql(
  condition: TargetAssignmentConditionRecord,
  values: readonly string[],
  parameter: (value: unknown) => string,
): string {
  const parts = condition.field.split(".");
  const normalizedValues = values.map((value) => normalize(value));
  const expected = parameter(condition.operator === "contains_phrase"
    ? values.map((value) => `% ${normalizePhrase(value)} %`)
    : condition.operator === "regex"
      ? values.map(postgresRegex)
      : normalizedValues);
  const comparison = (valuePath: string, phrasePath?: string): string => condition.operator === "contains_phrase"
    ? `${phrasePath ?? `(' ' || BTRIM(REGEXP_REPLACE(LOWER(COALESCE(${valuePath}, '')), '[^[:alnum:]]+', ' ', 'g')) || ' ')`} LIKE ANY(${expected}::TEXT[])`
    : condition.operator === "regex"
      ? `EXISTS (SELECT 1 FROM UNNEST(${expected}::TEXT[]) regex(pattern) WHERE COALESCE(${valuePath}, '') ~* regex.pattern)`
      : `LOWER(COALESCE(${valuePath}, '')) = ANY(${expected}::TEXT[])`;
  if (parts[0] === "resolved" && parts.length === 2) {
    const typeCode = parameter(parts[1]);
    return `SELECT DISTINCT link.source_product_id
      FROM source_product_classification_links link
      JOIN classification_candidates candidate ON candidate.id = link.candidate_id
      JOIN reference_types type ON type.id = candidate.reference_type_id
      WHERE link.active = TRUE AND link.status = 'resolved' AND type.code = ${typeCode}
        AND ${comparison("link.resolved_reference_value_id::TEXT")}`;
  }
  if (parts[0] === "candidate" && parts.length >= 3) {
    const typeCode = parameter(parts[1]);
    if (parts.length === 3 && parts[2] === "sourceValue" && condition.operator === "contains_phrase") {
      return `SELECT DISTINCT link.source_product_id
        FROM UNNEST(${expected}::TEXT[]) phrase(pattern)
        CROSS JOIN LATERAL (
          SELECT candidate.id
          FROM classification_candidates candidate
          JOIN reference_types type ON type.id = candidate.reference_type_id
          WHERE type.code = ${typeCode} AND candidate.phrase_search_value LIKE phrase.pattern
          OFFSET 0
        ) candidate
        JOIN source_product_classification_links link ON link.candidate_id = candidate.id AND link.active = TRUE`;
    }
    const joins = parts[2] === "evidence"
      ? "JOIN source_product_classification_evidence evidence_row ON evidence_row.id = link.evidence_id"
      : "";
    const valuePath = parts.length === 3 && parts[2] === "sourceValue"
      ? "candidate.normalized_source_value"
      : parts.length === 4 && parts[2] === "context"
        ? `candidate.context->>${parameter(parts[3])}`
        : parts.length === 4 && parts[2] === "evidence"
          ? `evidence_row.evidence->>${parameter(parts[3])}`
          : null;
    if (valuePath === null) throw new Error(`Unsupported target assignment field: ${condition.field}`);
    return `SELECT DISTINCT link.source_product_id
      FROM source_product_classification_links link
      JOIN classification_candidates candidate ON candidate.id = link.candidate_id
      JOIN reference_types type ON type.id = candidate.reference_type_id
      ${joins}
      WHERE link.active = TRUE AND type.code = ${typeCode}
        AND ${comparison(valuePath, parts[2] === "sourceValue" ? "candidate.phrase_search_value" : undefined)}`;
  }
  if (parts[0] === "product" && parts.length === 3 && ["attribute", "metadata", "fact"].includes(parts[1]!)) {
    const section = parts[1] === "attribute" ? "attributes" : parts[1] === "metadata" ? "metadata" : "sourceFacts";
    return `SELECT internal.source_product_id FROM internal_products internal
      WHERE internal.status = 'classified'
        AND ${comparison(`internal.data#>>ARRAY[${parameter(section)}::TEXT, ${parameter(parts[2])}::TEXT]`)}`;
  }
  if (parts[0] === "product" && parts.length === 2 && ["title", "description"].includes(parts[1]!)) {
    return `SELECT internal.source_product_id FROM internal_products internal
      WHERE internal.status = 'classified'
        AND ${comparison(`internal.data->>${parameter(parts[1])}`)}`;
  }
  throw new Error(`Unsupported target assignment field: ${condition.field}`);
}

async function matchedProductsQuery(client: SqlClient, draft: TargetAssignmentRuleDraft): Promise<{ readonly sql: string; readonly parameters: readonly unknown[] }> {
  const parameters: unknown[] = [];
  const parameter = (value: unknown): string => { parameters.push(value); return `$${parameters.length}`; };
  const groups: string[] = [];
  for (const group of draft.conditionGroups) {
    const alternatives: string[] = [];
    for (const condition of group.conditions) {
      alternatives.push(conditionProductIdsSql(condition, await conditionValues(client, draft.targetId, condition), parameter));
    }
    groups.push(alternatives.map((sql) => `(${sql})`).join("\nUNION\n"));
  }
  return {
    parameters,
    sql: `WITH matched_ids AS MATERIALIZED (
  ${groups.map((sql) => `(${sql})`).join("\nINTERSECT\n")}
), matched AS MATERIALIZED (
  SELECT internal.source_product_id, COALESCE(internal.data->>'title', '') AS title, COALESCE(internal.data->>'sku', '') AS sku
  FROM matched_ids
  JOIN internal_products internal ON internal.source_product_id = matched_ids.source_product_id
  WHERE internal.status = 'classified'
)
SELECT (SELECT COUNT(*)::INTEGER FROM matched) AS product_count,
  COALESCE((SELECT JSONB_AGG(TO_JSONB(example) ORDER BY example."sourceProductId"::BIGINT) FROM (
    SELECT source_product_id::TEXT AS "sourceProductId", title, sku FROM matched ORDER BY source_product_id DESC LIMIT 10
  ) example), '[]'::JSONB) AS examples`,
  };
}

async function insertConditions(client: SqlClient, ruleId: unknown, draft: TargetAssignmentRuleDraft): Promise<void> {
  for (const [groupPosition, group] of draft.conditionGroups.entries()) {
    const groupRow = (await client.query<DatabaseRow>(
      `INSERT INTO target_assignment_rule_condition_groups (rule_id, position) VALUES ($1, $2) RETURNING id`,
      [ruleId, groupPosition],
    )).rows[0]!;
    for (const [conditionPosition, condition] of group.conditions.entries()) {
      const inserted = await client.query<DatabaseRow>(
        `INSERT INTO target_assignment_rule_conditions (group_id, position, field, operator, match_set_id)
         SELECT $1, $2, $3, $4, match_set.id
         FROM (SELECT 1) seed
         LEFT JOIN target_assignment_match_sets match_set ON match_set.id = $5::BIGINT AND match_set.target_id = $6
         WHERE $5::BIGINT IS NULL OR match_set.id IS NOT NULL
         RETURNING id`,
        [groupRow.id, conditionPosition, condition.field, condition.operator, condition.matchSetId ?? null, draft.targetId],
      );
      if (inserted.rows.length === 0) throw new EntityNotFoundError("Target assignment match set", condition.matchSetId ?? "");
      if (condition.matchSetId !== undefined) continue;
      for (const [position, value] of uniqueValues(condition.values).entries()) {
        await client.query(
          `INSERT INTO target_assignment_rule_condition_values (condition_id, position, value, normalized_value)
           VALUES ($1, $2, $3, $4)`,
          [inserted.rows[0]!.id, position, value, normalize(value)],
        );
      }
    }
  }
}

async function insertActions(client: SqlClient, ruleId: unknown, draft: TargetAssignmentRuleDraft): Promise<void> {
  for (const action of draft.actions) {
    const inserted = await client.query<DatabaseRow>(
      `INSERT INTO target_assignment_rule_actions (rule_id, target_scope, dictionary_value_id, mode)
       SELECT $1, $2, dictionary.id, $4 FROM target_dictionary_values dictionary
       WHERE dictionary.id = $3 AND dictionary.target_id = $5 AND dictionary.active = TRUE RETURNING id`,
      [ruleId, action.targetScope, action.dictionaryValueId, action.mode, draft.targetId],
    );
    if (inserted.rows.length === 0) throw new EntityNotFoundError("Target dictionary value", action.dictionaryValueId);
  }
}

const selectedMatchSetsSql = `SELECT match_set.*,
  COALESCE(JSONB_AGG(value.value ORDER BY value.position) FILTER (WHERE value.id IS NOT NULL), '[]'::JSONB) AS values
FROM target_assignment_match_sets match_set
LEFT JOIN target_assignment_match_set_values value ON value.match_set_id = match_set.id
WHERE match_set.target_id = $1 AND ($2::BIGINT IS NULL OR match_set.id = $2)
GROUP BY match_set.id ORDER BY match_set.name, match_set.id`;

async function replaceMatchSetValues(client: SqlClient, matchSetId: unknown, values: readonly string[]): Promise<void> {
  await client.query("DELETE FROM target_assignment_match_set_values WHERE match_set_id = $1", [matchSetId]);
  const prepared = uniqueValues(values);
  await client.query(
    `INSERT INTO target_assignment_match_set_values (match_set_id, position, value, normalized_value)
     SELECT $1, (entry.ordinality - 1)::INTEGER, entry.value, entry.normalized_value
     FROM UNNEST($2::TEXT[], $3::TEXT[]) WITH ORDINALITY entry(value, normalized_value, ordinality)`,
    [matchSetId, prepared, prepared.map(normalize)],
  );
}

export class PostgresTargetAssignmentRuleRepository implements TargetAssignmentRuleRepository {
  constructor(private readonly pool: SqlPool) {}

  async list(targetId: string): Promise<readonly TargetAssignmentRuleRecord[]> {
    return withClient(this.pool, async (client) => (await client.query<DatabaseRow>(selectedRulesSql, [targetId, null])).rows.map(mapRule));
  }

  async preview(draft: TargetAssignmentRuleDraft): Promise<TargetAssignmentRulePreview> {
    return withClient(this.pool, async (client) => {
      const query = await matchedProductsQuery(client, draft);
      const row = (await client.query<DatabaseRow>(query.sql, [...query.parameters])).rows[0]!;
      return { productCount: Number(row.product_count), examples: row.examples as TargetAssignmentRulePreview["examples"] };
    });
  }

  async create(draft: TargetAssignmentRuleDraft, actor: string): Promise<TargetAssignmentRuleRecord> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const rule = (await client.query<DatabaseRow>(
          `INSERT INTO target_assignment_rules (target_id, name, group_code, priority, enabled, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [draft.targetId, draft.name, draft.groupCode, draft.priority, draft.enabled ?? true, actor],
        )).rows[0]!;
        await insertConditions(client, rule.id, draft);
        await insertActions(client, rule.id, draft);
        await client.query(`INSERT INTO target_assignment_rule_history (rule_id, action, new_value, actor) VALUES ($1, 'create', $2::JSONB, $3)`, [rule.id, JSON.stringify(draft), actor]);
        const result = await client.query<DatabaseRow>(selectedRulesSql, [draft.targetId, rule.id]);
        await client.query("COMMIT");
        return mapRule(result.rows[0]!);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  }

  async update(targetId: string, ruleId: string, draft: TargetAssignmentRuleDraft, expectedRevision: string, actor: string, reason?: string): Promise<TargetAssignmentRuleRecord> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const lock = (await client.query<DatabaseRow>("SELECT revision FROM target_assignment_rules WHERE id = $1 AND target_id = $2 FOR UPDATE", [ruleId, targetId])).rows[0];
        if (lock === undefined) throw new EntityNotFoundError("Target assignment rule", ruleId);
        if (String(lock.revision) !== expectedRevision) throw new IntegrationContractError("Target assignment rule was changed by another operator");
        const previous = mapRule((await client.query<DatabaseRow>(selectedRulesSql, [targetId, ruleId])).rows[0]!);
        await client.query(
          `UPDATE target_assignment_rules SET name = $3, group_code = $4, priority = $5, revision = revision + 1, updated_at = NOW()
           WHERE id = $1 AND target_id = $2`, [ruleId, targetId, draft.name, draft.groupCode, draft.priority],
        );
        await client.query("DELETE FROM target_assignment_rule_condition_groups WHERE rule_id = $1", [ruleId]);
        await client.query("DELETE FROM target_assignment_rule_actions WHERE rule_id = $1", [ruleId]);
        await insertConditions(client, ruleId, draft);
        await insertActions(client, ruleId, draft);
        const result = await client.query<DatabaseRow>(selectedRulesSql, [targetId, ruleId]);
        await client.query(
          `INSERT INTO target_assignment_rule_history (rule_id, action, previous_value, new_value, actor, reason)
           VALUES ($1, 'update', $2::JSONB, $3::JSONB, $4, $5)`,
          [ruleId, JSON.stringify(previous), JSON.stringify(mapRule(result.rows[0]!)), actor, reason ?? null],
        );
        await client.query("COMMIT");
        return mapRule(result.rows[0]!);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  }

  async setEnabled(targetId: string, ruleId: string, enabled: boolean, actor: string, reason?: string): Promise<TargetAssignmentRuleRecord> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const previous = (await client.query<DatabaseRow>("SELECT * FROM target_assignment_rules WHERE id = $1 AND target_id = $2 FOR UPDATE", [ruleId, targetId])).rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Target assignment rule", ruleId);
        await client.query(`UPDATE target_assignment_rules SET enabled = $2, revision = CASE WHEN enabled = $2 THEN revision ELSE revision + 1 END, updated_at = NOW() WHERE id = $1 AND target_id = $3`, [ruleId, enabled, targetId]);
        const updated = (await client.query<DatabaseRow>("SELECT * FROM target_assignment_rules WHERE id = $1", [ruleId])).rows[0]!;
        await client.query(`INSERT INTO target_assignment_rule_history (rule_id, action, previous_value, new_value, actor, reason) VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`, [ruleId, enabled ? "enable" : "disable", JSON.stringify(previous), JSON.stringify(updated), actor, reason ?? null]);
        const result = await client.query<DatabaseRow>(selectedRulesSql, [updated.target_id, ruleId]);
        await client.query("COMMIT");
        return mapRule(result.rows[0]!);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  }

  async history(targetId: string, ruleId: string): Promise<readonly TargetAssignmentHistoryRecord[]> {
    return withClient(this.pool, async (client) => (await client.query<DatabaseRow>(
      `SELECT history.* FROM target_assignment_rule_history history
       JOIN target_assignment_rules rule ON rule.id = history.rule_id
       WHERE history.rule_id = $1 AND rule.target_id = $2 ORDER BY history.created_at DESC, history.id DESC`, [ruleId, targetId],
    )).rows.map((row) => ({ id: String(row.id), action: String(row.action), actor: String(row.actor), reason: row.reason === null ? null : String(row.reason), previousValue: row.previous_value, newValue: row.new_value, createdAt: timestamp(row.created_at) })));
  }

  async listMatchSets(targetId: string): Promise<readonly TargetAssignmentMatchSetRecord[]> {
    return withClient(this.pool, async (client) => (await client.query<DatabaseRow>(selectedMatchSetsSql, [targetId, null])).rows.map(mapMatchSet));
  }

  async createMatchSet(draft: TargetAssignmentMatchSetDraft, actor: string): Promise<TargetAssignmentMatchSetRecord> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const saved = (await client.query<DatabaseRow>(`INSERT INTO target_assignment_match_sets (target_id, code, name, created_by) VALUES ($1, $2, $3, $4) RETURNING *`, [draft.targetId, draft.code, draft.name, actor])).rows[0]!;
        await replaceMatchSetValues(client, saved.id, draft.values);
        const result = await client.query<DatabaseRow>(selectedMatchSetsSql, [draft.targetId, saved.id]);
        await client.query(`INSERT INTO target_assignment_match_set_history (match_set_id, action, new_value, actor, reason) VALUES ($1, 'create', $2::JSONB, $3, $4)`, [saved.id, JSON.stringify(mapMatchSet(result.rows[0]!)), actor, draft.reason ?? null]);
        await client.query("COMMIT");
        return mapMatchSet(result.rows[0]!);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  }

  async updateMatchSet(targetId: string, matchSetId: string, draft: TargetAssignmentMatchSetDraft, expectedRevision: string, actor: string): Promise<TargetAssignmentMatchSetRecord> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const lock = (await client.query<DatabaseRow>("SELECT revision FROM target_assignment_match_sets WHERE id = $1 AND target_id = $2 FOR UPDATE", [matchSetId, targetId])).rows[0];
        if (lock === undefined) throw new EntityNotFoundError("Target assignment match set", matchSetId);
        if (String(lock.revision) !== expectedRevision) throw new IntegrationContractError("Target assignment match set was changed by another operator");
        const previous = mapMatchSet((await client.query<DatabaseRow>(selectedMatchSetsSql, [targetId, matchSetId])).rows[0]!);
        await client.query(`UPDATE target_assignment_match_sets SET code = $3, name = $4, revision = revision + 1, updated_at = NOW() WHERE id = $1 AND target_id = $2`, [matchSetId, targetId, draft.code, draft.name]);
        await replaceMatchSetValues(client, matchSetId, draft.values);
        const result = await client.query<DatabaseRow>(selectedMatchSetsSql, [targetId, matchSetId]);
        await client.query(`INSERT INTO target_assignment_match_set_history (match_set_id, action, previous_value, new_value, actor, reason) VALUES ($1, 'update', $2::JSONB, $3::JSONB, $4, $5)`, [matchSetId, JSON.stringify(previous), JSON.stringify(mapMatchSet(result.rows[0]!)), actor, draft.reason ?? null]);
        await client.query("COMMIT");
        return mapMatchSet(result.rows[0]!);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  }

  async listMatchSetOverlaps(targetId: string): Promise<readonly TargetAssignmentMatchSetOverlap[]> {
    return withClient(this.pool, async (client) => (await client.query<DatabaseRow>(
      `SELECT left_set.id::TEXT AS left_set_id, left_set.name AS left_set_name,
              right_set.id::TEXT AS right_set_id, right_set.name AS right_set_name,
              JSONB_AGG(left_value.value ORDER BY left_value.value) AS values
       FROM target_assignment_match_sets left_set
       JOIN target_assignment_match_sets right_set ON right_set.target_id = left_set.target_id AND right_set.id > left_set.id
       JOIN target_assignment_match_set_values left_value ON left_value.match_set_id = left_set.id
       JOIN target_assignment_match_set_values right_value ON right_value.match_set_id = right_set.id AND right_value.normalized_value = left_value.normalized_value
       WHERE left_set.target_id = $1
       GROUP BY left_set.id, right_set.id HAVING COUNT(*) > 0
       ORDER BY left_set.name, right_set.name`, [targetId],
    )).rows.map((row) => ({ leftSetId: String(row.left_set_id), leftSetName: String(row.left_set_name), rightSetId: String(row.right_set_id), rightSetName: String(row.right_set_name), values: row.values as readonly string[] })));
  }
}
