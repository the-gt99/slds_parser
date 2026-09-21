import type { UniversalProductDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { RuleV2Draft, RuleV2Record } from "../repositories/index.js";
import type { SqlExecutor, SqlPool } from "../infrastructure/db/sql-executor.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { DirectRulesV2Assignments } from "./rules-v2-direct-assignments.js";
import { rulesV2TargetEntities } from "./rules-v2-fields.js";

const requiredTargetFields = [
  { scope: "product.brand", label: "Бренд", candidateType: "brand" },
  { scope: "product.model", label: "Модель", candidateType: "model" },
  { scope: "product.category", label: "Категория", candidateType: "category" },
] as const;

export type RulesV2WorkbenchStatus = "incomplete" | "conflict" | "ready" | "all";

export interface RulesV2WorkbenchQuery {
  readonly sourceId: string;
  readonly targetId: string;
  readonly search?: string;
  readonly status?: RulesV2WorkbenchStatus;
  readonly offset?: number;
  readonly limit?: number;
}

interface WorkbenchRow {
  readonly id: string;
  readonly source_id: string;
  readonly source_key: string;
  readonly external_id: string | null;
  readonly code: string;
  readonly data: UniversalProductDTO;
  readonly updated_at: string;
}

function effectiveDescription(product: UniversalProductDTO): string {
  return (product.translatedContent?.story || product.translatedContent?.description || product.description).trim();
}

function validateProductFacts(product: UniversalProductDTO): readonly { readonly code: string; readonly message: string }[] {
  const blockers: { code: string; message: string }[] = [];
  if (product.title.trim() === "") blockers.push({ code: "title_missing", message: "Не заполнено обязательное название." });
  if (effectiveDescription(product) === "") blockers.push({ code: "description_missing", message: "Не заполнено обязательное описание." });
  if (product.images.length === 0) blockers.push({ code: "images_missing", message: "Нет ни одного подготовленного изображения." });
  if (product.variants.length === 0) blockers.push({ code: "variants_missing", message: "Нет ни одной вариации товара." });
  product.variants.forEach((variant, index) => {
    if (variant.size.sourceValue.trim() === "" || variant.size.displayValue.trim() === "") {
      blockers.push({ code: "variant_size_missing", message: `У вариации ${index + 1} не заполнен размер.` });
    }
    if (variant.inventory.availability === "available" && variant.price === null) {
      blockers.push({ code: "variant_price_missing", message: `У доступной вариации ${index + 1} не заполнена цена.` });
    }
  });
  return blockers;
}

function ruleIdentity(rule: RuleV2Record): string {
  return rule.originId ?? rule.id;
}

/** Deliberately bounded preview using the same evaluator as the shadow audit. */
export class RulesV2PreviewService {
  constructor(private readonly pool: SqlPool) {}

  async workbench(query: RulesV2WorkbenchQuery) {
    const limit = query.limit ?? 40;
    const offset = query.offset ?? 0;
    const status = query.status ?? "incomplete";
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new IntegrationContractError("Workbench limit must be from 1 to 100");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new IntegrationContractError("Workbench offset must be a non-negative integer");
    if (!["incomplete", "conflict", "ready", "all"].includes(status)) throw new IntegrationContractError("Unsupported workbench status");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runtime = new RulesV2Runtime(client, () => 0);
      const snapshot = await runtime.snapshot();
      const direct = new DirectRulesV2Assignments(snapshot.records, query.targetId);
      const search = query.search?.trim() ?? "";
      const rows = (await client.query<WorkbenchRow>(`
        SELECT product.id::TEXT, product.source_id::TEXT, product.source_key, product.external_id,
               source.code, internal.data, internal.updated_at::TEXT
        FROM source_products product
        JOIN sources source ON source.id = product.source_id
        JOIN internal_products internal ON internal.source_product_id = product.id
        WHERE product.source_id = $1
          AND ($2::TEXT = '' OR product.id::TEXT = $2 OR COALESCE(product.external_id, '') ILIKE '%' || $2 || '%'
            OR COALESCE(internal.data->>'title', '') ILIKE '%' || $2 || '%'
            OR COALESCE(internal.data->>'sku', '') ILIKE '%' || $2 || '%')
        ORDER BY product.id DESC
        LIMIT $3 OFFSET $4`, [query.sourceId, search, limit + 1, offset])).rows;
      const records = new Map(snapshot.records.map((rule) => [ruleIdentity(rule), rule]));
      const evaluated = rows.slice(0, limit).map((row) => this.workbenchItem(row, direct, records));
      const items = evaluated.filter((item) => status === "all" || item.status === status
        || (status === "incomplete" && item.status === "conflict"));
      await client.query("COMMIT");
      return {
        mode: "resulting_target_dto" as const,
        requiredTargetFields: requiredTargetFields.map(({ scope, label }) => ({ scope, label, minimum: 1 })),
        items,
        scannedCount: evaluated.length,
        counts: {
          ready: evaluated.filter((item) => item.status === "ready").length,
          incomplete: evaluated.filter((item) => item.status === "incomplete").length,
          conflict: evaluated.filter((item) => item.status === "conflict").length,
        },
        page: { offset, limit, hasMore: rows.length > limit, nextOffset: rows.length > limit ? offset + limit : null },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private workbenchItem(row: WorkbenchRow, direct: DirectRulesV2Assignments, records: ReadonlyMap<string, RuleV2Record>) {
    const source = { id: row.source_id, code: row.code, productId: row.id, sourceKey: row.source_key, externalId: row.external_id };
    const values = new Map<string, Map<string, { readonly id: string; readonly label: string }>>();
    const add = (scope: string, id: string, label: string) => {
      const scoped = values.get(scope) ?? new Map<string, { id: string; label: string }>();
      scoped.set(id, { id, label });
      values.set(scope, scoped);
    };
    const blockers = [...validateProductFacts(row.data)];
    const conflicts: { code: string; message: string }[] = [];
    const trace: { ruleId: string; name: string; groupCode: string | null; kind: string; changes: readonly string[] }[] = [];
    let decision: ReturnType<DirectRulesV2Assignments["resolveTerms"]> | null = null;
    let assignments: ReturnType<DirectRulesV2Assignments["resolve"]> = [];
    try {
      decision = direct.resolveTerms(row.data, source);
      assignments = direct.resolve(row.data, source);
      for (const term of decision.terms) add(term.targetScope, term.externalValue, term.externalLabel);
      const replacements = new Map<string, Set<string>>();
      for (const assignment of assignments) if (assignment.mode === "replace") {
        const groups = replacements.get(assignment.targetScope) ?? new Set<string>();
        groups.add(assignment.groupCode);
        replacements.set(assignment.targetScope, groups);
      }
      for (const [scope, groups] of replacements) {
        if (groups.size > 1) conflicts.push({ code: "replace_conflict",
          message: `Поле ${scope} заменяется несколькими независимыми группами: ${[...groups].join(", ")}.` });
        values.set(scope, new Map());
      }
      for (const assignment of assignments) add(assignment.targetScope, assignment.externalValue, assignment.externalLabel);
      const traced = new Set<string>();
      for (const selection of decision.selections) {
        if (selection.sourceRuleId === null || traced.has(`source:${selection.sourceRuleId}`)) continue;
        traced.add(`source:${selection.sourceRuleId}`);
        const rule = snapshotRule(records, selection.sourceRuleId);
        trace.push({ ruleId: selection.sourceRuleId, name: rule?.name ?? `Правило #${selection.sourceRuleId}`,
          groupCode: rule?.groupCode ?? null, kind: "source", changes: [`${selection.candidateKey}: ${selection.status}`] });
      }
      for (const assignment of assignments) {
        if (traced.has(`assignment:${assignment.ruleId}`)) continue;
        traced.add(`assignment:${assignment.ruleId}`);
        const rule = records.get(assignment.ruleId);
        trace.push({ ruleId: assignment.ruleId, name: rule?.name ?? `Правило #${assignment.ruleId}`,
          groupCode: assignment.groupCode, kind: "target",
          changes: assignments.filter((item) => item.ruleId === assignment.ruleId)
            .map((item) => `${item.mode} ${item.targetScope}: ${item.externalLabel}`) });
      }
    } catch (error) {
      conflicts.push({ code: "rules_conflict", message: error instanceof Error ? error.message : String(error) });
    }
    for (const field of requiredTargetFields) {
      if ((values.get(field.scope)?.size ?? 0) > 0) continue;
      const sourceValues = row.data.referenceCandidates.filter((candidate) => candidate.typeCode === field.candidateType)
        .map((candidate) => candidate.sourceValue);
      blockers.push({ code: `required_${field.candidateType}_missing`, message: sourceValues.length > 0
        ? `Не заполнено обязательное поле «${field.label}»: данные донора есть, но итоговое правило не назначило WordPress-значение.`
        : `Не заполнено обязательное поле «${field.label}»: подходящих данных донора нет.` });
    }
    const fields = Object.fromEntries([...values].map(([scope, scoped]) => [scope, [...scoped.values()]]));
    return {
      sourceProductId: row.id,
      sourceExternalId: row.external_id,
      title: row.data.title,
      sku: row.data.sku,
      updatedAt: row.updated_at,
      status: conflicts.length > 0 ? "conflict" as const : blockers.length > 0 ? "incomplete" as const : "ready" as const,
      blockers,
      conflicts,
      result: {
        title: row.data.title,
        descriptionPresent: effectiveDescription(row.data) !== "",
        imageCount: row.data.images.length,
        variantCount: row.data.variants.length,
        fields,
      },
      candidates: Object.fromEntries(requiredTargetFields.map((field) => [field.scope,
        row.data.referenceCandidates.filter((candidate) => candidate.typeCode === field.candidateType)
          .map((candidate) => ({ key: candidate.key, sourceValue: candidate.sourceValue, context: candidate.context }))])),
      trace,
    };
  }

  async preview(draft: RuleV2Draft) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await this.evaluate(client, draft);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async evaluate(db: SqlExecutor, draft: RuleV2Draft) {
    const runtime = new RulesV2Runtime(db, () => 0);
    const snapshot = await runtime.snapshot();
    const dictionary = await db.query<{ id: string; external_id: string; name: string; entity_type: string }>(`SELECT id::TEXT, external_id, name, entity_type
      FROM target_dictionary_values WHERE id = ANY($1::BIGINT[]) AND target_id = $2 AND active = TRUE`,
    [draft.actions.map((a) => a.dictionaryValueId), draft.targetId]);
    const values = new Map(dictionary.rows.map((row) => [row.id, row]));
    const actions = draft.actions.map((action) => {
      const value = values.get(action.dictionaryValueId);
      if (value === undefined) throw new IntegrationContractError("Selected dictionary value is unavailable");
      if (rulesV2TargetEntities[action.targetScope] !== value.entity_type) throw new IntegrationContractError("Selected dictionary value belongs to another field");
      return { ...action, externalValue: value.external_id, externalLabel: value.name };
    });
    const preview: RuleV2Record = { ...draft, id: "0", sourceCode: null, targetCode: null, actions, status: "shadow",
      originKind: "native", originId: null, originRevision: "1", originPayload: {}, revision: "1", createdAt: "", updatedAt: "" };
    const withDraft = new DirectRulesV2Assignments([...snapshot.records.filter((rule) => rule.id !== draft.previewRuleId), preview], draft.targetId);
    const rows = (await db.query<{ id: string; source_key: string; external_id: string | null; code: string; data: UniversalProductDTO }>(`
      SELECT product.id::TEXT, product.source_key, product.external_id, source.code, internal.data
      FROM source_products product JOIN sources source ON source.id = product.source_id
      JOIN internal_products internal ON internal.source_product_id = product.id
      WHERE product.source_id = $1 AND internal.data ? 'referenceCandidates'
      ORDER BY product.id DESC LIMIT 200`, [draft.sourceId])).rows;
    let productCount = 0;
    const examples: { sourceProductId: string; title: string; actions: typeof actions }[] = [];
    const conflicts: { sourceProductId: string; message: string }[] = [];
    for (const row of rows) {
      const source = { id: draft.sourceId, code: row.code, productId: row.id, sourceKey: row.source_key, externalId: row.external_id };
      if (!withDraft.matchesRule(preview.id, row.data, source)) continue;
      productCount++;
      if (examples.length < 10) examples.push({ sourceProductId: row.id, title: row.data.title, actions });
      try {
        withDraft.resolve(row.data, source);
      } catch (error) {
        if (conflicts.length < 10) conflicts.push({ sourceProductId: row.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { scope: "sample" as const, examined: rows.length, productCount, examples, conflicts, writes: false };
  }
}

function snapshotRule(records: ReadonlyMap<string, RuleV2Record>, id: string): RuleV2Record | undefined {
  return records.get(id) ?? [...records.values()].find((rule) => rule.id === id);
}
