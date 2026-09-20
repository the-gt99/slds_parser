import type { UniversalProductDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { RuleV2Draft, RuleV2Record } from "../repositories/index.js";
import type { SqlExecutor, SqlPool } from "../infrastructure/db/sql-executor.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { PostgresClassificationRepository } from "../infrastructure/db/repositories/postgres-classification-repository.js";
import { ProductClassifier } from "./product-classifier.js";
import { RulesV2Snapshot, rulesV2FieldReader } from "./rules-v2-snapshot.js";
import { matchesTargetAssignmentCondition } from "./target-assignment-rule-matcher.js";
import { rulesV2TargetEntities } from "./rules-v2-fields.js";

/** Deliberately bounded preview using the same evaluator as the shadow audit. */
export class RulesV2PreviewService {
  constructor(private readonly pool: SqlPool) {}
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
    const withDraft = new RulesV2Snapshot(snapshot.revision, [...snapshot.records.filter((rule) => rule.id !== draft.previewRuleId), preview]);
    const classifier = new ProductClassifier(runtime.classificationRepository(new PostgresClassificationRepository(db)));
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
      const product = (await classifier.classify(draft.sourceId, row.data)).product;
      const source = { id: draft.sourceId, code: row.code, productId: row.id, sourceKey: row.source_key, externalId: row.external_id };
      const read = rulesV2FieldReader(product, source);
      if (!draft.conditionGroups.every((group) => group.conditions.some((condition) => matchesTargetAssignmentCondition(product, condition, read)))) continue;
      productCount++;
      if (examples.length < 10) examples.push({ sourceProductId: row.id, title: product.title, actions });
      try { withDraft.nativeAssignments(draft.targetId, product, source); }
      catch (error) { if (conflicts.length < 10) conflicts.push({ sourceProductId: row.id, message: error instanceof Error ? error.message : String(error) }); }
    }
    return { scope: "sample" as const, examined: rows.length, productCount, examples, conflicts, writes: false };
  }
}
