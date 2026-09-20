import type { JsonValue, UniversalProductDTO } from "../contracts/index.js";
import { writeFile } from "node:fs/promises";
import { stableJsonStringify } from "../core/utils/index.js";
import { createPostgresPool } from "../infrastructure/db/index.js";
import { loadRulesV2AuditBaseline } from "../infrastructure/db/rules-v2-audit-baseline.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { ProductClassifier } from "../services/product-classifier.js";
import { resolveTargetAssignments } from "../services/target-assignment-rule-matcher.js";

const limit = Number(process.env.RULES_V2_AUDIT_LIMIT ?? "1000");
const after = process.env.RULES_V2_AUDIT_AFTER ?? "0";
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000000 || !/^\d+$/u.test(after)) throw new Error("Invalid audit limit/cursor");
const pool = createPostgresPool();
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const { classifications: legacy, targets: references } = await loadRulesV2AuditBaseline(client);
  const runtime = new RulesV2Runtime(client, () => 0);
  const snapshot = await runtime.snapshot();
  const control = (await client.query<{ legacy_revision: string }>(
    "SELECT legacy_revision::TEXT FROM rules_execution_control WHERE singleton")).rows[0];
  if (control === undefined) throw new Error("Rules execution control is missing");
  const total = Number((await client.query<{ count: string }>(`SELECT COUNT(*)::TEXT AS count
    FROM source_products product JOIN internal_products internal ON internal.source_product_id = product.id
    WHERE internal.data ? 'referenceCandidates'`)).rows[0]?.count);
  const classifiers = [new ProductClassifier(legacy), new ProductClassifier(runtime.classificationRepository(legacy))];
  const targets = (await client.query<{ id: string }>("SELECT id::TEXT FROM targets ORDER BY id")).rows;
  const assignmentRules = new Map(await Promise.all(targets.map(async (target) => [target.id, await references.listTargetAssignmentRules(target.id)] as const)));
  const examples: unknown[] = [];
  let checked = 0;
  let mismatches = 0;
  let lastId = after;
  async function compare(id: string, section: string, left: unknown, right: unknown) {
    if (stableJsonStringify(left as JsonValue) === stableJsonStringify(right as JsonValue)) return;
    mismatches++;
    if (examples.length < 20) examples.push({ sourceProductId: id, section, legacy: left, v2: right });
  }
  while (checked < limit) {
    const started = performance.now();
    const rows = (await client.query<{ id: string; source_id: string; code: string; source_key: string; external_id: string | null; data: UniversalProductDTO }>(`
      SELECT product.id::TEXT, product.source_id::TEXT, source.code, product.source_key, product.external_id, internal.data
      FROM source_products product JOIN internal_products internal ON internal.source_product_id = product.id
      JOIN sources source ON source.id = product.source_id
      WHERE product.id > $1 AND internal.source_product_id > $1
        AND internal.data ? 'referenceCandidates' ORDER BY product.id LIMIT $2`,
    [lastId, Math.min(200, limit - checked)])).rows;
    if (rows.length === 0) break;
    const queried = performance.now();
    for (const row of rows) {
      const old = await classifiers[0]!.classify(row.source_id, row.data);
      const next = await classifiers[1]!.classify(row.source_id, row.data);
      await compare(row.id, "classification", { classification: old.product.classification, observations: old.observations },
        { classification: next.product.classification, observations: next.observations });
      const resolutions = old.product.classification.resolved.map((item) => ({ resolutionKind: item.resolutionKind, resolutionId: item.resolutionId, referenceId: item.referenceValueId }));
      for (const target of targets) {
        for (const item of old.product.classification.resolved) {
          await compare(row.id, `mapping:${target.id}:${item.candidateKey}`,
            await references.resolveTargetValue(target.id, item.referenceValueId, item.scope),
            snapshot.mapping(target.id, item.referenceValueId, item.scope));
        }
        await compare(row.id, `projections:${target.id}`, await references.resolveTargetProjections(target.id, resolutions), snapshot.projections(target.id, resolutions));
        const outcome = (callback: () => unknown) => { try { return { result: callback() }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } };
        await compare(row.id, `assignments:${target.id}`,
          outcome(() => resolveTargetAssignments(old.product, assignmentRules.get(target.id)!)),
          outcome(() => snapshot.nativeAssignments(target.id, next.product, { id: row.source_id, code: row.code, productId: row.id, sourceKey: row.source_key, externalId: row.external_id })));
      }
      checked++;
      lastId = row.id;
    }
    console.info(JSON.stringify({ progress: checked, mismatches, lastId, queryMs: Math.round(queried - started), evaluateMs: Math.round(performance.now() - queried) }));
  }
  await client.query("COMMIT");
  const report = { revision: snapshot.revision, legacyRevision: control.legacy_revision,
    checked, total, complete: after === "0" && checked === total, mismatches, lastId, writes: false, examples };
  if (process.env.RULES_V2_AUDIT_REPORT) await writeFile(process.env.RULES_V2_AUDIT_REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.info(JSON.stringify(report, null, 2));
  if (mismatches > 0 || checked === 0) process.exitCode = 1;
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally { client.release(); await pool.end(); }
