import type { UniversalProductDTO } from "../contracts/index.js";
import { randomUUID } from "node:crypto";
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
  readonly missingField?: "brand" | "model" | "category";
  readonly sort?: "latest" | "title" | "problems";
  readonly productId?: string;
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
  if (!product.images.some((image) => image.url.trim() !== "")) blockers.push({ code: "images_missing", message: "Нет ни одного подготовленного изображения." });
  if (product.variants.length === 0) blockers.push({ code: "variants_missing", message: "Нет ни одной вариации товара." });
  product.variants.forEach((variant, index) => {
    if (variant.size.sourceValue.trim() === "" || variant.size.displayValue.trim() === "") {
      blockers.push({ code: "variant_size_missing", message: `У вариации ${index + 1} не заполнен размер.` });
    }
    if (variant.inventory.availability === "unknown") {
      blockers.push({ code: "variant_availability_missing", message: `У вариации ${index + 1} не определено наличие.` });
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

/** Read-only workbench index and rule impact previews using the active V2 evaluator. */
export class RulesV2PreviewService {
  private readonly indexing = new Map<string, string>();
  private readonly indexErrors = new Map<string, string>();
  private readonly fullPreviews = new Map<string, { status: "running" | "complete" | "failed"; checked: number;
    total: number; matched: number; newlyReady: number; filled: Record<string, number>; existing: number;
    changedExisting: number; conflictCount: number;
    conflicts: { sourceProductId: string; message: string }[];
    examples: { sourceProductId: string; title: string; before: string; after: string;
      beforeFields: Record<string, string[]>; afterFields: Record<string, string[]> }[]; error: string | undefined }>();
  constructor(private readonly pool: SqlPool) {}

  async workbench(query: RulesV2WorkbenchQuery) {
    const limit = query.limit ?? 40;
    const offset = query.offset ?? 0;
    const status = query.status ?? "incomplete";
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new IntegrationContractError("Workbench limit must be from 1 to 100");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new IntegrationContractError("Workbench offset must be a non-negative integer");
    if (!["incomplete", "conflict", "ready", "all"].includes(status)) throw new IntegrationContractError("Unsupported workbench status");
    if (query.missingField !== undefined && !["brand", "model", "category"].includes(query.missingField)) throw new IntegrationContractError("Unsupported required field");
    if (query.sort !== undefined && !["latest", "title", "problems"].includes(query.sort)) throw new IntegrationContractError("Unsupported workbench sort");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runtime = new RulesV2Runtime(client, () => 0);
      const snapshot = await runtime.snapshot();
      if (query.productId !== undefined) {
        const rows = (await client.query<WorkbenchRow>(`
        SELECT product.id::TEXT, product.source_id::TEXT, product.source_key, product.external_id,
               source.code, internal.data, internal.updated_at::TEXT
        FROM source_products product
        JOIN sources source ON source.id = product.source_id
        JOIN internal_products internal ON internal.source_product_id = product.id
        WHERE product.source_id = $1 AND product.id = $2`, [query.sourceId, query.productId])).rows;
        const direct = new DirectRulesV2Assignments(snapshot.records, query.targetId);
        const records = new Map(snapshot.records.map((rule) => [ruleIdentity(rule), rule]));
        const items = rows.map((row) => this.workbenchItem(row, direct, records));
        await client.query("COMMIT");
        return { mode: "resulting_target_dto" as const, requiredTargetFields, items, scannedCount: items.length,
          counts: { ready: items.filter((item) => item.status === "ready").length,
            incomplete: items.filter((item) => item.status === "incomplete").length,
            conflict: items.filter((item) => item.status === "conflict").length },
          index: { complete: true, indexed: items.length, total: items.length },
          page: { offset: 0, limit: 1, hasMore: false, nextOffset: null } };
      }
      const revision = snapshot.revision;
      const state = (await client.query<{ rules_revision: string; complete: boolean }>(
        "SELECT rules_revision, complete FROM rules_v2_workbench_state WHERE source_id = $1 AND target_id = $2",
        [query.sourceId, query.targetId])).rows[0];
      const complete = state?.rules_revision === revision && state.complete;
      const search = query.search?.trim() ?? "";
      const missing = query.missingField === undefined ? "" : `required_${query.missingField}_missing`;
      const order = query.sort === "title" ? "item.title COLLATE \"C\" ASC, item.source_product_id DESC"
        : query.sort === "problems" ? "item.issue_count DESC, item.source_product_id DESC"
          : "item.product_updated_at DESC, item.source_product_id DESC";
      const filter = `item.source_id = $1 AND item.target_id = $2 AND item.rules_revision = $3
        AND item.product_updated_at = internal.updated_at
        AND ($4::TEXT = '' OR item.search_text ILIKE '%' || $4 || '%')
        AND ($5::TEXT = '' OR $5 = ANY(item.issue_codes))
        AND ($6::TEXT = 'all' OR item.status = $6 OR ($6 = 'incomplete' AND item.status = 'conflict'))`;
      const values = [query.sourceId, query.targetId, revision, search, missing, status];
      const rows = (await client.query<Record<string, unknown>>(`SELECT item.* FROM rules_v2_workbench_items item
        JOIN internal_products internal ON internal.source_product_id = item.source_product_id
        WHERE ${filter} ORDER BY ${order} LIMIT $7 OFFSET $8`, [...values, limit + 1, offset])).rows;
      const count = (await client.query<{ total: number }>(`SELECT COUNT(*)::INT AS total FROM rules_v2_workbench_items item
        JOIN internal_products internal ON internal.source_product_id = item.source_product_id WHERE ${filter}`, values)).rows[0]?.total ?? 0;
      const counts = (await client.query<{ status: string; count: number }>(`SELECT item.status, COUNT(*)::INT AS count
        FROM rules_v2_workbench_items item JOIN internal_products internal ON internal.source_product_id = item.source_product_id
        WHERE item.source_id = $1 AND item.target_id = $2 AND item.rules_revision = $3
        AND item.product_updated_at = internal.updated_at GROUP BY item.status`, [query.sourceId, query.targetId, revision])).rows;
      const indexed = counts.reduce((sum, row) => sum + row.count, 0);
      const total = (await client.query<{ count: number }>(`SELECT COUNT(*)::INT AS count FROM internal_products internal
        JOIN source_products product ON product.id = internal.source_product_id WHERE product.source_id = $1`, [query.sourceId])).rows[0]?.count ?? 0;
      await client.query("COMMIT");
      const indexError = this.indexErrors.get(`${query.sourceId}:${query.targetId}`) ?? null;
      this.startIndexing(query.sourceId, query.targetId, revision, snapshot.records);
      const items = rows.slice(0, limit).map((row) => ({ sourceProductId: String(row.source_product_id),
        sourceExternalId: row.source_external_id, title: row.title, sku: row.sku, updatedAt: row.updated_at,
        status: row.status, blockers: row.blockers, conflicts: row.conflicts, result: row.result,
        candidates: row.candidates, trace: row.trace }));
      return { mode: "resulting_target_dto" as const, requiredTargetFields, items, scannedCount: indexed,
        counts: Object.fromEntries(["ready", "incomplete", "conflict"].map((kind) => [kind, counts.find((row) => row.status === kind)?.count ?? 0])),
        index: { complete: complete && indexed === total, indexed, total, error: indexError }, filteredCount: count,
        page: { offset, limit, hasMore: rows.length > limit, nextOffset: rows.length > limit ? offset + limit : null } };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private startIndexing(sourceId: string, targetId: string, revision: string, records: readonly RuleV2Record[]): void {
    const key = `${sourceId}:${targetId}`;
    if (this.indexing.has(key)) { this.indexing.set(key, revision); return; }
    this.indexing.set(key, revision);
    this.indexErrors.delete(key);
    const direct = new DirectRulesV2Assignments(records, targetId);
    const byId = new Map(records.map((rule) => [ruleIdentity(rule), rule]));
    const run = async () => {
      try {
        while (this.indexing.get(key) === revision && await this.indexBatch(sourceId, targetId, revision, direct, byId)) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      } finally { this.indexing.delete(key); }
    };
    void run().catch((error: unknown) => {
      this.indexErrors.set(key, error instanceof Error ? error.message : String(error));
      console.error("Rules V2 workbench indexing failed", error);
    });
  }

  private async indexBatch(sourceId: string, targetId: string, revision: string, direct: DirectRulesV2Assignments,
    records: ReadonlyMap<string, RuleV2Record>): Promise<boolean> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(`INSERT INTO rules_v2_workbench_state (source_id, target_id, rules_revision, cursor_id, sweep_max_id)
        VALUES ($1, $2, $3, (SELECT MAX(product.id) FROM source_products product
          JOIN internal_products internal ON internal.source_product_id = product.id WHERE product.source_id = $1),
          (SELECT MAX(product.id) FROM source_products product
          JOIN internal_products internal ON internal.source_product_id = product.id WHERE product.source_id = $1))
        ON CONFLICT (source_id, target_id) DO NOTHING`, [sourceId, targetId, revision]);
      let state = (await db.query<{ rules_revision: string; cursor_id: string | null; sweep_max_id: string | null; floor_id: string; complete: boolean }>(
        `SELECT rules_revision, cursor_id::TEXT, sweep_max_id::TEXT, floor_id::TEXT, complete FROM rules_v2_workbench_state
         WHERE source_id = $1 AND target_id = $2 FOR UPDATE`, [sourceId, targetId])).rows[0]!;
      if (state.rules_revision !== revision) {
        await db.query(`UPDATE rules_v2_workbench_state SET rules_revision = $3, floor_id = 0, complete = FALSE,
          cursor_id = (SELECT MAX(product.id) FROM source_products product JOIN internal_products internal
            ON internal.source_product_id = product.id WHERE product.source_id = $1),
          sweep_max_id = (SELECT MAX(product.id) FROM source_products product JOIN internal_products internal
            ON internal.source_product_id = product.id WHERE product.source_id = $1), updated_at = NOW()
          WHERE source_id = $1 AND target_id = $2`, [sourceId, targetId, revision]);
        state = (await db.query<{ rules_revision: string; cursor_id: string | null; sweep_max_id: string | null; floor_id: string; complete: boolean }>(
          `SELECT rules_revision, cursor_id::TEXT, sweep_max_id::TEXT, floor_id::TEXT, complete
           FROM rules_v2_workbench_state WHERE source_id = $1 AND target_id = $2`, [sourceId, targetId])).rows[0]!;
      }
      const dirty = (await db.query<WorkbenchRow>(`SELECT product.id::TEXT, product.source_id::TEXT, product.source_key,
        product.external_id, source.code, internal.data, internal.updated_at::TEXT
        FROM rules_v2_workbench_items item JOIN source_products product ON product.id = item.source_product_id
        JOIN sources source ON source.id = product.source_id JOIN internal_products internal ON internal.source_product_id = product.id
        WHERE item.source_id = $1 AND item.target_id = $2 AND item.rules_revision = $3
          AND item.product_updated_at IS DISTINCT FROM internal.updated_at
        ORDER BY product.id DESC LIMIT 100`, [sourceId, targetId, revision])).rows;
      let rows = dirty;
      if (rows.length === 0 && state.cursor_id !== null) {
        rows = (await db.query<WorkbenchRow>(`SELECT product.id::TEXT, product.source_id::TEXT, product.source_key,
          product.external_id, source.code, internal.data, internal.updated_at::TEXT
          FROM source_products product JOIN sources source ON source.id = product.source_id
          JOIN internal_products internal ON internal.source_product_id = product.id
          WHERE product.source_id = $1 AND product.id <= $2 AND product.id > $3
          ORDER BY product.id DESC LIMIT 100`, [sourceId, state.cursor_id, state.floor_id])).rows;
      }
      if (rows.length === 0) {
        const maxId = (await db.query<{ id: string | null }>(`SELECT MAX(product.id)::TEXT AS id FROM source_products product
          JOIN internal_products internal ON internal.source_product_id = product.id WHERE product.source_id = $1`, [sourceId])).rows[0]?.id;
        if (maxId !== undefined && maxId !== null && BigInt(maxId) > BigInt(state.sweep_max_id ?? "0")) {
          await db.query(`UPDATE rules_v2_workbench_state SET cursor_id = $3, sweep_max_id = $3,
            floor_id = COALESCE(sweep_max_id, 0), complete = FALSE, updated_at = NOW()
            WHERE source_id = $1 AND target_id = $2`, [sourceId, targetId, maxId]);
          await db.query("COMMIT");
          return true;
        }
        await db.query(`UPDATE rules_v2_workbench_state SET cursor_id = NULL,
          floor_id = COALESCE(sweep_max_id, floor_id), complete = TRUE, updated_at = NOW()
          WHERE source_id = $1 AND target_id = $2`, [sourceId, targetId]);
        await db.query("COMMIT");
        return false;
      }
      for (const row of rows) {
        const item = this.workbenchItem(row, direct, records);
        const candidateText = row.data.referenceCandidates.map((candidate) => candidate.sourceValue).join(" ");
        const donorText = `${JSON.stringify(row.data.attributes ?? {})} ${JSON.stringify(row.data.sourceFacts ?? {})}`;
        const targetText = Object.values(item.result.fields).flat().map((value) => value.label).join(" ");
        await db.query(`INSERT INTO rules_v2_workbench_items (source_product_id, target_id, source_id, rules_revision,
          product_updated_at, status, issue_count, issue_codes, search_text, title, source_external_id, sku,
          result, blockers, conflicts, candidates, trace)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT (source_product_id, target_id) DO UPDATE SET rules_revision = EXCLUDED.rules_revision,
          product_updated_at = EXCLUDED.product_updated_at, status = EXCLUDED.status,
          issue_count = EXCLUDED.issue_count, issue_codes = EXCLUDED.issue_codes,
          search_text = EXCLUDED.search_text, title = EXCLUDED.title,
          source_external_id = EXCLUDED.source_external_id, sku = EXCLUDED.sku,
          result = EXCLUDED.result, blockers = EXCLUDED.blockers, conflicts = EXCLUDED.conflicts,
          candidates = EXCLUDED.candidates, trace = EXCLUDED.trace, updated_at = NOW()`,
        [row.id, targetId, sourceId, revision, row.updated_at, item.status,
          item.blockers.length + item.conflicts.length, [...item.blockers, ...item.conflicts].map((issue) => issue.code),
          `${row.id} ${item.title} ${item.sku} ${item.sourceExternalId ?? ""} ${candidateText} ${donorText} ${targetText}`, item.title,
          item.sourceExternalId, item.sku, JSON.stringify(item.result), JSON.stringify(item.blockers),
          JSON.stringify(item.conflicts), JSON.stringify(item.candidates), JSON.stringify(item.trace)]);
      }
      if (dirty.length === 0) {
        const lastId = rows.at(-1)!.id;
        await db.query(`UPDATE rules_v2_workbench_state SET cursor_id = $3, updated_at = NOW()
          WHERE source_id = $1 AND target_id = $2`, [sourceId, targetId, (BigInt(lastId) - 1n).toString()]);
      }
      await db.query("COMMIT");
      return true;
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
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
        imageCount: row.data.images.filter((image) => image.url.trim() !== "").length,
        variantCount: row.data.variants.length,
        fields,
      },
      candidates: Object.fromEntries(requiredTargetFields.map((field) => [field.scope,
        row.data.referenceCandidates.filter((candidate) => candidate.typeCode === field.candidateType)
          .map((candidate) => ({ key: candidate.key, sourceValue: candidate.sourceValue, context: candidate.context }))])),
      trace,
    };
  }

  startFullPreview(draft: RuleV2Draft): { id: string } {
    if ([...this.fullPreviews.values()].some((job) => job.status === "running")) {
      throw new IntegrationContractError("Полная проверка другого правила уже выполняется");
    }
    while (this.fullPreviews.size >= 10) this.fullPreviews.delete(this.fullPreviews.keys().next().value!);
    const id = randomUUID();
    const job = { status: "running" as "running" | "complete" | "failed", checked: 0, total: 0,
      matched: 0, newlyReady: 0, filled: {} as Record<string, number>, existing: 0, changedExisting: 0, conflictCount: 0,
      conflicts: [] as { sourceProductId: string; message: string }[],
      examples: [] as { sourceProductId: string; title: string; before: string; after: string;
        beforeFields: Record<string, string[]>; afterFields: Record<string, string[]> }[], error: undefined as string | undefined };
    this.fullPreviews.set(id, job);
    void this.runFullPreview(draft, job).catch((error: unknown) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    });
    return { id };
  }

  fullPreviewStatus(id: string) {
    const job = this.fullPreviews.get(id);
    if (job === undefined) throw new IntegrationContractError("Проверка правила не найдена");
    return job;
  }

  private async runFullPreview(draft: RuleV2Draft, job: NonNullable<ReturnType<RulesV2PreviewService["fullPreviewStatus"]>>): Promise<void> {
    const db = await this.pool.connect();
    try {
      const snapshot = await new RulesV2Runtime(db, () => 0).snapshot();
      const dictionary = (await db.query<{ id: string; external_id: string; name: string; entity_type: string }>(
        `SELECT id::TEXT, external_id, name, entity_type FROM target_dictionary_values
         WHERE id = ANY($1::BIGINT[]) AND target_id = $2 AND active = TRUE`,
        [draft.actions.map((action) => action.dictionaryValueId), draft.targetId])).rows;
      const values = new Map(dictionary.map((row) => [row.id, row]));
      const actions = draft.actions.map((action) => {
        const value = values.get(action.dictionaryValueId);
        if (value === undefined || value.entity_type !== rulesV2TargetEntities[action.targetScope]) {
          throw new IntegrationContractError("Выбранное значение WordPress недоступно для поля");
        }
        return { ...action, externalValue: value.external_id, externalLabel: value.name };
      });
      const preview: RuleV2Record = { ...draft, id: "0", sourceCode: null, targetCode: null, actions,
        status: "shadow", originKind: "native", originId: null, originRevision: "1", originPayload: {},
        revision: "1", createdAt: "", updatedAt: "" };
      const replacing = snapshot.records.filter((rule) => rule.id !== draft.previewRuleId);
      const before = new DirectRulesV2Assignments(snapshot.records, draft.targetId);
      const after = new DirectRulesV2Assignments([...replacing, preview], draft.targetId);
      const beforeRecords = new Map(snapshot.records.map((rule) => [ruleIdentity(rule), rule]));
      const afterRecords = new Map([...replacing.map((rule): [string, RuleV2Record] => [ruleIdentity(rule), rule]), ["0", preview] as [string, RuleV2Record]]);
      job.total = (await db.query<{ count: number }>(`SELECT COUNT(*)::INT AS count FROM internal_products internal
        JOIN source_products product ON product.id = internal.source_product_id
        WHERE product.source_id = $1`, [draft.sourceId])).rows[0]?.count ?? 0;
      let lastId = "0";
      while (true) {
        const rows = (await db.query<WorkbenchRow>(`SELECT product.id::TEXT, product.source_id::TEXT,
          product.source_key, product.external_id, source.code, internal.data, internal.updated_at::TEXT
          FROM source_products product JOIN sources source ON source.id = product.source_id
          JOIN internal_products internal ON internal.source_product_id = product.id
          WHERE product.source_id = $1 AND product.id > $2
          ORDER BY product.id LIMIT 250`, [draft.sourceId, lastId])).rows;
        if (!rows.length) break;
        for (const row of rows) {
          lastId = row.id; job.checked++;
          const source = { id: row.source_id, code: row.code, productId: row.id,
            sourceKey: row.source_key, externalId: row.external_id };
          if (!after.matchesRule("0", row.data, source)) continue;
          job.matched++;
          const prior = this.workbenchItem(row, before, beforeRecords);
          const next = this.workbenchItem(row, after, afterRecords);
          if (prior.status !== "ready" && next.status === "ready") job.newlyReady++;
          let hadExisting = false;
          let changedExisting = false;
          for (const scope of new Set(actions.map((action) => action.targetScope))) {
            const oldValues = prior.result.fields[scope] ?? [];
            const newValues = next.result.fields[scope] ?? [];
            if (oldValues.length > 0) hadExisting = true;
            if (oldValues.length > 0 && JSON.stringify(oldValues.map((value) => value.id).sort())
              !== JSON.stringify(newValues.map((value) => value.id).sort())) changedExisting = true;
            if (oldValues.length === 0 && newValues.length > 0) {
              job.filled[scope] = (job.filled[scope] ?? 0) + 1;
            }
          }
          if (hadExisting) job.existing++;
          if (changedExisting) job.changedExisting++;
          if (next.conflicts.length) {
            job.conflictCount++;
            if (job.conflicts.length < 20) job.conflicts.push({
              sourceProductId: row.id, message: next.conflicts.map((issue) => issue.message).join("; ") });
          }
          if (job.examples.length < 12) {
            const scopes = [...new Set(actions.map((action) => action.targetScope))];
            const labels = (fields: typeof prior.result.fields) => Object.fromEntries(scopes.map((scope) =>
              [scope, (fields[scope] ?? []).map((value) => value.label)]));
            job.examples.push({ sourceProductId: row.id, title: row.data.title,
              before: prior.status, after: next.status,
              beforeFields: labels(prior.result.fields), afterFields: labels(next.result.fields) });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const currentRevision = (await new RulesV2Runtime(db, () => 0).snapshot()).revision;
      if (currentRevision !== snapshot.revision) throw new IntegrationContractError("Правила изменились во время проверки. Запустите её повторно.");
      job.status = "complete";
    } finally { db.release(); }
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
