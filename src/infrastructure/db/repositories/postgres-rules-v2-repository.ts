import { EntityNotFoundError, IntegrationContractError } from "../../../core/errors/index.js";
import type { RuleV2Draft, RuleV2Record, RulesV2Repository, RuleV2Summary, RuleV2ImportedDraft, RuleV2StoredAction } from "../../../repositories/index.js";
import { stableJsonStringify } from "../../../core/utils/index.js";
import type { JsonValue } from "../../../contracts/index.js";
import type { SqlClient, SqlExecutor, SqlPool } from "../sql-executor.js";
import type { DatabaseRow } from "./row-mappers.js";
import { rulesV2TargetEntities, validateRulesV2Field } from "../../../services/rules-v2-fields.js";
import { compileTargetAssignmentRegex } from "../../../services/target-assignment-rule-matcher.js";

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalized(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function selector(draft: Pick<RuleV2Draft, "conditionGroups">) {
  const condition = draft.conditionGroups[0]?.conditions[0];
  if (condition === undefined) throw new IntegrationContractError("Rule v2 requires at least one condition");
  return {
    field: condition.field,
    operator: condition.operator,
    values: condition.values.map(normalized).filter(Boolean),
  };
}

export function mapRuleV2(row: DatabaseRow): RuleV2Record {
  return {
    id: String(row.id), sourceId: row.source_id === null ? null : String(row.source_id),
    sourceCode: row.source_code === null ? null : String(row.source_code),
    targetId: row.target_id === null ? null : String(row.target_id),
    targetCode: row.target_code === null ? null : String(row.target_code), name: String(row.name),
    groupCode: String(row.group_code), priority: Number(row.priority), status: row.status as RuleV2Record["status"],
    conditionGroups: row.condition_groups as RuleV2Record["conditionGroups"],
    actions: row.actions as RuleV2Record["actions"], originKind: row.origin_kind as RuleV2Record["originKind"],
    originId: row.origin_id === null ? null : String(row.origin_id), revision: String(row.revision),
    originRevision: String(row.origin_revision), originPayload: row.origin_payload as RuleV2Record["originPayload"],
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}

const selectedSql = `SELECT rule.*, source.code AS source_code, target.code AS target_code
  FROM rules_v2 rule
  LEFT JOIN sources source ON source.id = rule.source_id
  LEFT JOIN targets target ON target.id = rule.target_id`;

async function withClient<Result>(pool: SqlPool, callback: (client: SqlClient) => Promise<Result>): Promise<Result> {
  const client = await pool.connect();
  try { return await callback(client); } finally { client.release(); }
}

async function enrichedActions(client: SqlClient, draft: RuleV2Draft) {
  const ids = [...new Set(draft.actions.map((action) => action.dictionaryValueId))];
  const result = await client.query<DatabaseRow>(
    `SELECT id::TEXT, external_id, name, entity_type FROM target_dictionary_values
     WHERE target_id = $1 AND active = TRUE AND id = ANY($2::BIGINT[])`,
    [draft.targetId, ids],
  );
  const values = new Map(result.rows.map((row) => [String(row.id), row]));
  if (values.size !== ids.length) throw new IntegrationContractError("One or more WordPress values do not belong to the selected target");
  return draft.actions.map((action) => {
    const value = values.get(action.dictionaryValueId)!;
    if (rulesV2TargetEntities[action.targetScope] === undefined || rulesV2TargetEntities[action.targetScope] !== value.entity_type) {
      throw new IntegrationContractError("WordPress value does not belong to the selected field");
    }
    return { ...action, externalValue: String(value.external_id), externalLabel: String(value.name) };
  });
}

async function insertHistory(client: SqlClient, ruleId: unknown, action: string, previous: unknown, current: unknown, actor: string, reason?: string) {
  await client.query(
    `INSERT INTO rules_v2_history (rule_id, action, previous_value, new_value, actor, reason)
     VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $6)`,
    [ruleId, action, previous === null ? null : JSON.stringify(previous), JSON.stringify(current), actor, reason ?? null],
  );
}

export class PostgresRulesV2Repository implements RulesV2Repository {
  constructor(private readonly pool: SqlPool & SqlExecutor) {}

  async updateImported(id: string, draft: RuleV2ImportedDraft, expectedRevision: string, actor: string): Promise<RuleV2Record> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const previous = (await client.query<DatabaseRow>("SELECT * FROM rules_v2 WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Rule v2", id);
        const rule = mapRuleV2(previous);
        if (rule.originKind === "native") throw new IntegrationContractError("Use the native editor for this rule");
        if (rule.revision !== expectedRevision) throw new IntegrationContractError("Rule v2 was changed by another operator");
        const payload = { ...rule.originPayload, manualOverride: true };
        const equal = (a: unknown, b: unknown) => stableJsonStringify(a as JsonValue) === stableJsonStringify(b as JsonValue);
        const reference = rule.actions.find((action) => action.kind === "resolve_reference");
        if (rule.originKind === "classification_rule" && reference?.kind === "resolve_reference") {
          const conditions = draft.conditionGroups.map((group) => {
            const condition = group.conditions[0];
            const prefix = `candidate.${reference.referenceType}.`;
            if (group.conditions.length !== 1 || condition === undefined || !condition.field.startsWith(prefix)
              || !/^(?:sourceValue|scope|subjectKind|(?:context|evidence)\.[a-zA-Z][a-zA-Z0-9_-]*)$/u.test(condition.field.slice(prefix.length))
              || condition.values.length !== 1 || !["equals", "contains", "all_words", "regex"].includes(condition.operator)) {
              throw new IntegrationContractError("Migrated classification conditions must keep their candidate scope and AND semantics");
            }
            return { field: condition.field.slice(prefix.length), operator: condition.operator, value: condition.values[0]! };
          });
          Object.assign(payload, { conditions });
        } else if (rule.originKind === "target_assignment_rule") {
          for (const group of draft.conditionGroups) for (const condition of group.conditions) {
            validateRulesV2Field(condition.field);
            if (!["equals", "one_of", "contains_phrase", "regex", "absent"].includes(condition.operator)) throw new IntegrationContractError("Unsupported target assignment operator");
            if (condition.operator === "regex") condition.values.forEach(compileTargetAssignmentRegex);
            if (condition.operator === "absent" && condition.matchSetId !== undefined) throw new IntegrationContractError("absent does not accept match sets");
          }
        } else if (!equal(draft.conditionGroups, rule.conditionGroups)) {
          throw new IntegrationContractError("This rule depends on an exact decision; change its source rule instead of replacing the dependency");
        }
        let actions: readonly RuleV2StoredAction[];
        if (reference?.kind === "resolve_reference") {
          const action = draft.actions[0];
          if (draft.actions.length !== 1 || action?.kind !== "resolve_reference" || action.referenceType !== reference.referenceType
            || (action.resolutionStatus === "ignored" && rule.originKind !== "exact_mapping")) throw new IntegrationContractError("Invalid migrated reference action");
          if (action.resolutionStatus === "ignored") {
            actions = [{ ...reference, resolutionStatus: "ignored" as const, referenceValueId: null, referenceValueCode: null, referenceValueName: null }];
          } else {
            const selected = (await client.query<DatabaseRow>(`SELECT value.id::TEXT, value.code, value.name
              FROM reference_values value JOIN reference_types type ON type.id = value.type_id
              WHERE value.id = $1 AND type.code = $2 AND value.enabled = TRUE`, [action.referenceValueId, reference.referenceType])).rows[0];
            if (selected === undefined) throw new IntegrationContractError("Reference value does not belong to the selected type");
            actions = [{ ...reference, resolutionStatus: "confirmed" as const, referenceValueId: String(selected.id), referenceValueCode: String(selected.code), referenceValueName: String(selected.name) }];
          }
        } else {
          if (rule.targetId === null || draft.actions.some((action) => action.kind === "resolve_reference")) throw new IntegrationContractError("Invalid target actions");
          if (rule.originKind !== "target_assignment_rule" && draft.actions.length !== 1) throw new IntegrationContractError("A migrated target binding must keep one action; use a native rule for multiple actions");
          const direct = draft.actions as RuleV2Draft["actions"];
          if (rule.originKind !== "target_assignment_rule" && (direct[0]?.targetScope !== (rule.actions[0] as { targetScope: string }).targetScope
            || direct[0]?.mode !== (rule.actions[0] as { mode: string }).mode)) throw new IntegrationContractError("Keep the target binding scope and mode");
          actions = await enrichedActions(client, { sourceId: rule.sourceId ?? "0", targetId: rule.targetId, name: draft.name,
            groupCode: rule.groupCode, priority: draft.priority, status: draft.status, conditionGroups: draft.conditionGroups, actions: direct });
        }
        const primary = selector(draft);
        const updated = (await client.query<DatabaseRow>(`UPDATE rules_v2 SET name = $2, priority = $3, status = $4,
          condition_groups = $5::JSONB, actions = $6::JSONB, origin_payload = $7::JSONB,
          selector_field = $8, selector_operator = $9, selector_values_normalized = $10::TEXT[],
          origin_revision = origin_revision + 1, revision = revision + 1, updated_at = NOW()
          WHERE id = $1 RETURNING *`, [id, draft.name, draft.priority, draft.status, JSON.stringify(draft.conditionGroups), JSON.stringify(actions), JSON.stringify(payload), primary.field, primary.operator, primary.values])).rows[0]!;
        await insertHistory(client, id, previous.status === draft.status ? "update" : "status", previous, updated, actor,
          "Изменил копию v2; последующий импорт не перезаписывает её");
        const selected = (await client.query<DatabaseRow>(`${selectedSql} WHERE rule.id = $1`, [id])).rows[0]!;
        await client.query("COMMIT"); return mapRuleV2(selected);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  }

  async list(targetId?: string, query: { readonly search?: string; readonly offset?: number; readonly limit?: number } = {}): Promise<readonly RuleV2Record[]> {
    const result = await this.pool.query<DatabaseRow>(
      `${selectedSql} WHERE ($1::BIGINT IS NULL OR rule.target_id = $1 OR rule.target_id IS NULL)
       AND ($2::TEXT = '' OR rule.name ILIKE '%' || $2 || '%' OR rule.id::TEXT = $2
         OR rule.condition_groups::TEXT ILIKE '%' || $2 || '%' OR rule.actions::TEXT ILIKE '%' || $2 || '%')
       ORDER BY rule.priority DESC, rule.id DESC LIMIT $3 OFFSET $4`,
      [targetId ?? null, query.search ?? "", query.limit ?? 101, query.offset ?? 0],
    );
    return result.rows.map(mapRuleV2);
  }

  async summary(): Promise<RuleV2Summary> {
    const result = await this.pool.query<DatabaseRow>(`SELECT
      COUNT(*)::INTEGER AS total,
      COUNT(*) FILTER (WHERE JSONB_ARRAY_LENGTH(condition_groups) = 1
        AND JSONB_ARRAY_LENGTH(condition_groups->0->'conditions') = 1
        AND condition_groups#>>'{0,conditions,0,operator}' = 'equals')::INTEGER AS exact_count,
      COUNT(*) FILTER (WHERE status = 'draft')::INTEGER AS draft,
      COUNT(*) FILTER (WHERE status = 'shadow')::INTEGER AS shadow,
      COUNT(*) FILTER (WHERE status = 'disabled')::INTEGER AS disabled,
      (SELECT COUNT(*)::INTEGER FROM source_reference_mappings) AS exact_mappings,
      (SELECT COUNT(*)::INTEGER FROM source_reference_rules WHERE enabled = TRUE) AS classification_rules,
      (SELECT COUNT(*)::INTEGER FROM target_value_mappings WHERE active = TRUE) AS target_mappings,
      ((SELECT COUNT(*) FROM target_classification_projections WHERE active = TRUE)
        + (SELECT COUNT(*) FROM target_reference_projections WHERE active = TRUE))::INTEGER AS projections,
      (SELECT COUNT(*)::INTEGER FROM target_assignment_rules WHERE enabled = TRUE) AS target_assignment_rules
      , COALESCE((SELECT JSONB_OBJECT_AGG(origin_kind, amount) FROM (
          SELECT origin_kind, COUNT(*)::INTEGER AS amount FROM rules_v2 GROUP BY origin_kind
        ) origin_counts), '{}'::JSONB) AS origins
      FROM rules_v2`);
    const row = result.rows[0]!;
    return {
      catalog: { total: Number(row.total), exact: Number(row.exact_count), conditional: Number(row.total) - Number(row.exact_count) },
      native: { draft: Number(row.draft), shadow: Number(row.shadow), disabled: Number(row.disabled) },
      legacy: {
        exactMappings: Number(row.exact_mappings), classificationRules: Number(row.classification_rules),
        targetMappings: Number(row.target_mappings), projections: Number(row.projections),
        targetAssignmentRules: Number(row.target_assignment_rules),
      },
      origins: row.origins as RuleV2Summary["origins"],
    };
  }

  async create(draft: RuleV2Draft, actor: string): Promise<RuleV2Record> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const primary = selector(draft);
        const actions = await enrichedActions(client, draft);
        const inserted = await client.query<DatabaseRow>(
          `INSERT INTO rules_v2 (source_id, target_id, name, group_code, priority, status, condition_groups, actions,
             selector_field, selector_operator, selector_values_normalized, created_by)
           SELECT source.id, target.id, $3, $4, $5, $6, $7::JSONB, $8::JSONB, $9, $10, $11::TEXT[], $12
           FROM sources source CROSS JOIN targets target WHERE source.id = $1 AND target.id = $2
           RETURNING *`,
          [draft.sourceId, draft.targetId, draft.name, draft.groupCode, draft.priority, draft.status,
            JSON.stringify(draft.conditionGroups), JSON.stringify(actions), primary.field, primary.operator, primary.values, actor],
        );
        if (inserted.rows.length === 0) throw new IntegrationContractError("Source or target was not found");
        await insertHistory(client, inserted.rows[0]!.id, "create", null, inserted.rows[0], actor, draft.reason);
        const selected = await client.query<DatabaseRow>(`${selectedSql} WHERE rule.id = $1`, [inserted.rows[0]!.id]);
        await client.query("COMMIT");
        return mapRuleV2(selected.rows[0]!);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  }

  async update(id: string, draft: RuleV2Draft, expectedRevision: string, actor: string): Promise<RuleV2Record> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        const previous = (await client.query<DatabaseRow>("SELECT * FROM rules_v2 WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (previous === undefined) throw new EntityNotFoundError("Rule v2", id);
        if (previous.origin_kind !== "native") throw new IntegrationContractError("Imported shadow copies are read-only; update the legacy source or create a native v2 rule");
        if (String(previous.revision) !== expectedRevision) throw new IntegrationContractError("Rule v2 was changed by another operator");
        const primary = selector(draft);
        const actions = await enrichedActions(client, draft);
        const updated = await client.query<DatabaseRow>(
          `UPDATE rules_v2 SET source_id = $2, target_id = $3, name = $4, group_code = $5, priority = $6,
             status = $7, condition_groups = $8::JSONB, actions = $9::JSONB, selector_field = $10,
             selector_operator = $11, selector_values_normalized = $12::TEXT[], revision = revision + 1, updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [id, draft.sourceId, draft.targetId, draft.name, draft.groupCode, draft.priority, draft.status,
            JSON.stringify(draft.conditionGroups), JSON.stringify(actions), primary.field, primary.operator, primary.values],
        );
        await insertHistory(client, id, previous.status === draft.status ? "update" : "status", previous, updated.rows[0], actor, draft.reason);
        const selected = await client.query<DatabaseRow>(`${selectedSql} WHERE rule.id = $1`, [id]);
        await client.query("COMMIT");
        return mapRuleV2(selected.rows[0]!);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  }
}
