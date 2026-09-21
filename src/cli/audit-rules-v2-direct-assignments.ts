import type { UniversalProductDTO } from "../contracts/index.js";
import { createPostgresPool } from "../infrastructure/db/index.js";
import { loadRulesV2AuditBaseline } from "../infrastructure/db/rules-v2-audit-baseline.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { ProductClassifier } from "../services/product-classifier.js";
import { DirectRulesV2Assignments } from "../services/rules-v2-direct-assignments.js";

const limit = Number(process.env.RULES_V2_DIRECT_ASSIGNMENT_LIMIT ?? "1000");
const after = process.env.RULES_V2_DIRECT_ASSIGNMENT_AFTER ?? "0";
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000000 || !/^\d+$/u.test(after)) {
  throw new Error("Invalid direct assignment audit limit/cursor");
}
const pool = createPostgresPool();
const client = await pool.connect();
let transactionOpen = false;
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  transactionOpen = true;
  const baseline = await loadRulesV2AuditBaseline(client);
  const runtime = new RulesV2Runtime(client, () => 0);
  const snapshot = await runtime.snapshot();
  const classifier = new ProductClassifier(runtime.classificationRepository(baseline.classifications));
  const targetIds = [...new Set(snapshot.records.filter((rule) => rule.targetId !== null
    && (rule.originKind === "target_assignment_rule" || rule.originKind === "native")).map((rule) => rule.targetId!))];
  const direct = new Map(targetIds.map((targetId) => [targetId, new DirectRulesV2Assignments(snapshot.records, targetId)]));
  await client.query("COMMIT");
  transactionOpen = false;
  const examples: unknown[] = [];
  let mismatches = 0;
  let checked = 0;
  let lastId = after;
  let reachedEnd = false;
  const outcome = (run: () => unknown) => { try { return { result: run() }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } };
  const normalized = (result: ReturnType<typeof outcome>) => "result" in result && Array.isArray(result.result)
    ? JSON.stringify([...result.result].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
    : JSON.stringify(result);
  while (checked < limit) {
    const rows = (await client.query<{ id: string; source_id: string; code: string; source_key: string;
      external_id: string | null; data: UniversalProductDTO }>(`SELECT product.id::TEXT, product.source_id::TEXT,
      source.code, product.source_key, product.external_id, internal.data FROM source_products product
      JOIN sources source ON source.id = product.source_id JOIN internal_products internal ON internal.source_product_id = product.id
      WHERE product.id > $1::BIGINT AND internal.source_product_id > $1::BIGINT
        AND internal.data ? 'referenceCandidates' ORDER BY product.id LIMIT $2`,
    [lastId, Math.min(200, limit - checked)])).rows;
    if (rows.length === 0) { reachedEnd = true; break; }
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
      checked++;
      lastId = row.id;
    }
    console.info(JSON.stringify({ progress: checked, mismatches, lastId }));
  }
  const stamp = (await client.query<{ revision: string }>(`SELECT
    COALESCE(SUM(revision), 0)::TEXT || ':' || COUNT(*)::TEXT || ':' || COALESCE(MAX(updated_at)::TEXT, '') AS revision
    FROM rules_v2`)).rows[0]!.revision;
  const dictionaryStamp = (await client.query<{ revision: string }>(
    "SELECT COALESCE(SUM(revision), 0)::TEXT AS revision FROM target_export_revisions")).rows[0]!.revision;
  const revisionChanged = `${stamp}:${dictionaryStamp}` !== snapshot.revision;
  console.info(JSON.stringify({ writes: false, revision: snapshot.revision, checked, lastId,
    complete: after === "0" && reachedEnd, targets: targetIds.length, mismatches, revisionChanged, examples }, null, 2));
  if (mismatches > 0 || revisionChanged || checked === 0) process.exitCode = 1;
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
