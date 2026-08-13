import { EntityNotFoundError } from "../../../core/errors/index.js";
import type {
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

function mapRule(row: DatabaseRow): TargetAssignmentRuleRecord {
  return {
    id: String(row.id), targetId: String(row.target_id), name: String(row.name), groupCode: String(row.group_code),
    priority: Number(row.priority), conditions: row.conditions as TargetAssignmentRuleRecord["conditions"],
    actions: row.actions as TargetAssignmentRuleRecord["actions"], enabled: Boolean(row.enabled), revision: String(row.revision),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}

async function withClient<Result>(pool: SqlPool, callback: (client: SqlClient) => Promise<Result>): Promise<Result> {
  const client = await pool.connect();
  try { return await callback(client); } finally { client.release(); }
}

const selectedRulesSql = `SELECT rule.*,
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

function matchedProductsQuery(conditions: TargetAssignmentRuleDraft["conditions"]): { readonly sql: string; readonly parameters: readonly unknown[] } {
  const parameters: unknown[] = [];
  const parameter = (value: unknown): string => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const clauses = conditions.map((condition) => {
    const parts = condition.field.split(".");
    const values = parameter(condition.values.map((value) => value.trim().toLocaleLowerCase("en-US")));
    if (parts[0] === "resolved" && parts.length === 2) {
      const typeCode = parameter(parts[1]);
      return `EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(COALESCE(internal.data#>'{classification,resolved}', '[]'::JSONB)) resolved
        WHERE resolved->>'typeCode' = ${typeCode}
          AND LOWER(COALESCE(resolved->>'referenceValueId', '')) = ANY(${values}::TEXT[])
      )`;
    }
    if (parts[0] === "candidate" && parts.length >= 3) {
      const typeCode = parameter(parts[1]);
      const valuePath = parts.length === 3 && parts[2] === "sourceValue"
        ? "candidate->>'sourceValue'"
        : parts.length === 4 && (parts[2] === "context" || parts[2] === "evidence")
          ? `candidate#>>ARRAY[${parameter(parts[2])}::TEXT, ${parameter(parts[3])}::TEXT]`
          : null;
      if (valuePath === null) throw new Error(`Unsupported target assignment field: ${condition.field}`);
      return `EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(COALESCE(internal.data->'referenceCandidates', '[]'::JSONB)) candidate
        WHERE candidate->>'typeCode' = ${typeCode}
          AND LOWER(COALESCE(${valuePath}, '')) = ANY(${values}::TEXT[])
      )`;
    }
    if (parts[0] === "product" && parts.length === 3 && ["attribute", "metadata", "fact"].includes(parts[1]!)) {
      const section = parts[1] === "attribute" ? "attributes" : parts[1] === "metadata" ? "metadata" : "sourceFacts";
      return `LOWER(COALESCE(internal.data#>>ARRAY[${parameter(section)}::TEXT, ${parameter(parts[2])}::TEXT], '')) = ANY(${values}::TEXT[])`;
    }
    throw new Error(`Unsupported target assignment field: ${condition.field}`);
  });
  return {
    parameters,
    sql: `WITH matched AS MATERIALIZED (
  SELECT internal.source_product_id, COALESCE(internal.data->>'title', '') AS title, COALESCE(internal.data->>'sku', '') AS sku
  FROM internal_products internal
  WHERE internal.status = 'classified'
    ${clauses.map((clause) => `AND ${clause}`).join("\n    ")}
)
SELECT (SELECT COUNT(*)::INTEGER FROM matched) AS product_count,
  COALESCE((SELECT JSONB_AGG(TO_JSONB(example) ORDER BY example."sourceProductId"::BIGINT) FROM (
    SELECT source_product_id::TEXT AS "sourceProductId", title, sku FROM matched ORDER BY source_product_id DESC LIMIT 10
  ) example), '[]'::JSONB) AS examples`,
  };
}

export class PostgresTargetAssignmentRuleRepository implements TargetAssignmentRuleRepository {
  constructor(private readonly pool: SqlPool) {}

  async list(targetId: string): Promise<readonly TargetAssignmentRuleRecord[]> {
    return withClient(this.pool, async (client) => (await client.query<DatabaseRow>(selectedRulesSql, [targetId, null])).rows.map(mapRule));
  }

  async preview(draft: TargetAssignmentRuleDraft): Promise<TargetAssignmentRulePreview> {
    return withClient(this.pool, async (client) => {
      const query = matchedProductsQuery(draft.conditions);
      const row = (await client.query<DatabaseRow>(query.sql, [...query.parameters])).rows[0]!;
      return { productCount: Number(row.product_count), examples: row.examples as TargetAssignmentRulePreview["examples"] };
    });
  }

  async create(draft: TargetAssignmentRuleDraft, actor: string): Promise<TargetAssignmentRuleRecord> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const saved = await client.query<DatabaseRow>(
          `INSERT INTO target_assignment_rules (target_id, name, group_code, priority, conditions, created_by)
           VALUES ($1, $2, $3, $4, $5::JSONB, $6) RETURNING *`,
          [draft.targetId, draft.name, draft.groupCode, draft.priority, JSON.stringify(draft.conditions), actor],
        );
        const rule = saved.rows[0]!;
        for (const action of draft.actions) {
          const inserted = await client.query<DatabaseRow>(
            `INSERT INTO target_assignment_rule_actions (rule_id, target_scope, dictionary_value_id, mode)
             SELECT $1, $2, dictionary.id, $4
             FROM target_dictionary_values dictionary
             WHERE dictionary.id = $3 AND dictionary.target_id = $5 AND dictionary.active = TRUE
             RETURNING id`,
            [rule.id, action.targetScope, action.dictionaryValueId, action.mode, draft.targetId],
          );
          if (inserted.rows.length === 0) throw new EntityNotFoundError("Target dictionary value", action.dictionaryValueId);
        }
        await client.query(
          `INSERT INTO target_assignment_rule_history (rule_id, action, new_value, actor)
           VALUES ($1, 'create', $2::JSONB, $3)`,
          [rule.id, JSON.stringify(draft), actor],
        );
        const result = await client.query<DatabaseRow>(selectedRulesSql, [draft.targetId, rule.id]);
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
        await client.query(
          `UPDATE target_assignment_rules SET enabled = $2,
             revision = CASE WHEN enabled = $2 THEN revision ELSE revision + 1 END, updated_at = NOW()
           WHERE id = $1 AND target_id = $3`, [ruleId, enabled, targetId],
        );
        const updated = (await client.query<DatabaseRow>("SELECT * FROM target_assignment_rules WHERE id = $1", [ruleId])).rows[0]!;
        await client.query(
          `INSERT INTO target_assignment_rule_history (rule_id, action, previous_value, new_value, actor, reason)
           VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`,
          [ruleId, enabled ? "enable" : "disable", JSON.stringify(previous), JSON.stringify(updated), actor, reason ?? null],
        );
        const result = await client.query<DatabaseRow>(selectedRulesSql, [updated.target_id, ruleId]);
        await client.query("COMMIT");
        return mapRule(result.rows[0]!);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  }
}
