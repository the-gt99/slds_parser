import type { UniversalProductDTO } from "../contracts/index.js";
import { createPostgresPool } from "../infrastructure/db/index.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { rulesV2FieldReader } from "../services/rules-v2-snapshot.js";
import { directRulesV2Conditions, directRulesV2Field } from "../services/rules-v2-direct-fields.js";

const limit = Number(process.env.RULES_V2_FIELD_AUDIT_LIMIT ?? "1000");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("Invalid field audit limit");
const pool = createPostgresPool();
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const snapshot = await new RulesV2Runtime(client, () => 0).snapshot();
  const sourceRules = snapshot.records.filter((rule) => rule.originKind === "exact_mapping" || rule.originKind === "classification_rule");
  const fields = new Set(sourceRules.flatMap((rule) => rule.conditionGroups.flatMap((group) => group.conditions.map((item) => item.field))));
  const blocked = new Map<string, number>();
  let convertible = 0;
  for (const rule of sourceRules) {
    if (directRulesV2Conditions(rule.conditionGroups) !== null) { convertible++; continue; }
    for (const field of new Set(rule.conditionGroups.flatMap((group) => group.conditions.map((item) => item.field)))) {
      if (directRulesV2Field(field) === null) blocked.set(field, (blocked.get(field) ?? 0) + 1);
    }
  }
  const rows = (await client.query<{ id: string; source_id: string; code: string; source_key: string;
    external_id: string | null; data: UniversalProductDTO }>(`SELECT product.id::TEXT, product.source_id::TEXT, source.code,
      product.source_key, product.external_id, internal.data
      FROM source_products product JOIN sources source ON source.id = product.source_id
      JOIN internal_products internal ON internal.source_product_id = product.id
      WHERE internal.data ? 'referenceCandidates' ORDER BY product.id LIMIT $1`, [limit])).rows;
  const mismatches: { readonly sourceProductId: string; readonly field: string; readonly expected: readonly string[];
    readonly actual: readonly string[] }[] = [];
  let mismatchCount = 0;
  const normalize = (values: readonly string[]) => [...new Set(values.map((value) => value.trim().normalize("NFKC").toLowerCase()))].sort();
  for (const row of rows) {
    const read = rulesV2FieldReader(row.data, { id: row.source_id, code: row.code, productId: row.id,
      sourceKey: row.source_key, externalId: row.external_id });
    for (const field of fields) {
      const direct = directRulesV2Field(field);
      if (direct === null) continue;
      const expected = normalize(read(field));
      const actual = normalize(read(direct));
      if (JSON.stringify(expected) === JSON.stringify(actual)) continue;
      mismatchCount++;
      if (mismatches.length < 20) mismatches.push({ sourceProductId: row.id, field, expected, actual });
    }
  }
  await client.query("COMMIT");
  console.info(JSON.stringify({ writes: false, rules: sourceRules.length, convertible, blocked: [...blocked].map(([field, count]) => ({ field, count })),
    checkedProducts: rows.length, comparedFields: [...fields].filter((field) => directRulesV2Field(field) !== null),
    mismatchCount, mismatches }, null, 2));
  if (mismatchCount > 0) process.exitCode = 1;
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
