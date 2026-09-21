import type { UniversalProductDTO } from "../contracts/index.js";
import { createPostgresPool } from "../infrastructure/db/index.js";
import { loadRulesV2AuditBaseline } from "../infrastructure/db/rules-v2-audit-baseline.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { ProductClassifier } from "../services/product-classifier.js";
import { DirectRulesV2Assignments } from "../services/rules-v2-direct-assignments.js";

const limit = Number(process.env.RULES_V2_DIRECT_ASSIGNMENT_LIMIT ?? "1000");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("Invalid direct assignment audit limit");
const pool = createPostgresPool();
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const baseline = await loadRulesV2AuditBaseline(client);
  const runtime = new RulesV2Runtime(client, () => 0);
  const snapshot = await runtime.snapshot();
  const classifier = new ProductClassifier(runtime.classificationRepository(baseline.classifications));
  const targetIds = [...new Set(snapshot.records.filter((rule) => rule.targetId !== null
    && (rule.originKind === "target_assignment_rule" || rule.originKind === "native")).map((rule) => rule.targetId!))];
  const direct = new Map(targetIds.map((targetId) => [targetId, new DirectRulesV2Assignments(snapshot.records, targetId)]));
  const rows = (await client.query<{ id: string; source_id: string; code: string; source_key: string;
    external_id: string | null; data: UniversalProductDTO }>(`SELECT product.id::TEXT, product.source_id::TEXT,
      source.code, product.source_key, product.external_id, internal.data FROM source_products product
      JOIN sources source ON source.id = product.source_id JOIN internal_products internal ON internal.source_product_id = product.id
      WHERE internal.data ? 'referenceCandidates' ORDER BY product.id LIMIT $1`, [limit])).rows;
  const examples: unknown[] = [];
  let mismatches = 0;
  const outcome = (run: () => unknown) => { try { return { result: run() }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } };
  const normalized = (result: ReturnType<typeof outcome>) => "result" in result && Array.isArray(result.result)
    ? JSON.stringify([...result.result].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
    : JSON.stringify(result);
  for (const row of rows) {
    const classified = await classifier.classify(row.source_id, row.data);
    const source = { id: row.source_id, code: row.code, productId: row.id, sourceKey: row.source_key,
      externalId: row.external_id };
    for (const targetId of targetIds) {
      const current = outcome(() => snapshot.nativeAssignments(targetId, classified.product, source));
      const next = outcome(() => direct.get(targetId)!.resolve(row.data, source));
      if (normalized(current) === normalized(next)) continue;
      mismatches++;
      if (examples.length < 20) examples.push({ productId: row.id, targetId, current, direct: next });
    }
  }
  await client.query("COMMIT");
  console.info(JSON.stringify({ writes: false, revision: snapshot.revision, products: rows.length,
    targets: targetIds.length, mismatches, examples }, null, 2));
  if (mismatches > 0) process.exitCode = 1;
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
