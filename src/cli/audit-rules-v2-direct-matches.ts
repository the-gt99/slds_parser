import type { UniversalProductDTO } from "../contracts/index.js";
import { createPostgresPool } from "../infrastructure/db/index.js";
import { loadRulesV2AuditBaseline } from "../infrastructure/db/rules-v2-audit-baseline.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { ProductClassifier } from "../services/product-classifier.js";
import { directRulesV2Conditions, matchesDirectRulesV2Conditions } from "../services/rules-v2-direct-fields.js";
import { rulesV2FieldReader } from "../services/rules-v2-snapshot.js";

const limit = Number(process.env.RULES_V2_DIRECT_MATCH_LIMIT ?? "100");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid direct match audit limit");
const pool = createPostgresPool();
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const baseline = await loadRulesV2AuditBaseline(client);
  const runtime = new RulesV2Runtime(client, () => 0);
  const snapshot = await runtime.snapshot();
  const classifier = new ProductClassifier(runtime.classificationRepository(baseline.classifications));
  const sourceRules = snapshot.records.flatMap((rule) => {
    if (rule.status !== "shadow" || rule.sourceId === null
      || (rule.originKind !== "exact_mapping" && rule.originKind !== "classification_rule")) return [];
    const action = rule.actions.find((item) => item.kind === "resolve_reference");
    if (action?.kind !== "resolve_reference" || action.resolutionStatus !== "confirmed") return [];
    const groups = directRulesV2Conditions(rule);
    return groups === null ? [] : [{ rule, groups }];
  });
  const bySource = new Map<string, typeof sourceRules>();
  const byOrigin = new Map<string, string>();
  for (const entry of sourceRules) {
    bySource.set(entry.rule.sourceId!, [...(bySource.get(entry.rule.sourceId!) ?? []), entry]);
    byOrigin.set(`${entry.rule.originKind}:${entry.rule.originId ?? entry.rule.id}`, entry.rule.id);
  }
  const rows = (await client.query<{ id: string; source_id: string; code: string; source_key: string;
    external_id: string | null; data: UniversalProductDTO }>(`SELECT product.id::TEXT, product.source_id::TEXT,
      source.code, product.source_key, product.external_id, internal.data FROM source_products product
      JOIN sources source ON source.id = product.source_id JOIN internal_products internal ON internal.source_product_id = product.id
      WHERE internal.data ? 'referenceCandidates' ORDER BY product.id LIMIT $1`, [limit])).rows;
  let missedWinners = 0;
  let extraMatches = 0;
  let productsWithExtras = 0;
  const examples: unknown[] = [];
  for (const row of rows) {
    const classified = await classifier.classify(row.source_id, row.data);
    const winners = new Set(classified.product.classification.resolved.map((item) => byOrigin.get(
      `${item.resolutionKind === "mapping" ? "exact_mapping" : "classification_rule"}:${item.resolutionId}`)).filter(
      (value): value is string => value !== undefined));
    const read = rulesV2FieldReader(row.data, { id: row.source_id, code: row.code, productId: row.id,
      sourceKey: row.source_key, externalId: row.external_id });
    const matching = new Set<string>();
    for (const { rule, groups } of bySource.get(row.source_id) ?? []) {
      if (matchesDirectRulesV2Conditions(row.data, groups, read)) matching.add(rule.id);
    }
    const missed = [...winners].filter((id) => !matching.has(id));
    const extra = [...matching].filter((id) => !winners.has(id));
    missedWinners += missed.length;
    extraMatches += extra.length;
    if (extra.length > 0) productsWithExtras++;
    if ((missed.length > 0 || extra.length > 0) && examples.length < 20) examples.push({ productId: row.id,
      winnerCount: winners.size, matchedCount: matching.size, missed, extra: extra.slice(0, 20) });
  }
  await client.query("COMMIT");
  console.info(JSON.stringify({ writes: false, revision: snapshot.revision, sourceRules: sourceRules.length,
    products: rows.length, missedWinners, extraMatches, productsWithExtras, examples }, null, 2));
  if (missedWinners > 0) process.exitCode = 1;
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
