import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SqlPool } from "../../src/infrastructure/db/sql-executor.js";
import { RulesV2PreviewService } from "../../src/services/rules-v2-preview.js";
import { indexedCandidatePageSql, indexedRulePredicate } from "../../src/services/rules-v2-candidate-query.js";

// Run against a session-local embedded PostgreSQL; no production connection is used.
const modulePath = process.env.RULES_QUERY_PGLITE_MODULE;
if (modulePath === undefined) throw new Error("RULES_QUERY_PGLITE_MODULE is required");
const { PGlite } = await import(pathToFileURL(modulePath).href);
const db = new PGlite();
try {
  await db.exec(`CREATE TABLE sources(id BIGINT PRIMARY KEY,code TEXT);
    CREATE TABLE targets(id BIGINT PRIMARY KEY);
    CREATE TABLE source_products(id BIGINT PRIMARY KEY,source_id BIGINT,source_key TEXT,external_id TEXT);
    CREATE TABLE internal_products(source_product_id BIGINT PRIMARY KEY,data JSONB,updated_at TIMESTAMPTZ,content_hash TEXT);
    CREATE TABLE rules_v2(revision BIGINT,updated_at TIMESTAMPTZ);
    INSERT INTO sources VALUES(1,'test'); INSERT INTO targets VALUES(1);`);
  // This schema matches the actual workbench migration; only the unrelated trigram index is omitted.
  const schema = await readFile("src/infrastructure/db/migrations/085_rules_v2_workbench_index.sql", "utf8");
  await db.exec(schema.replace(/CREATE INDEX rules_v2_workbench_search_idx[^;]+;/u, ""));
  for (const name of ["099_rules_v2_candidate_tokens.sql", "100_rules_v2_candidate_lookup.sql",
    "101_rules_v2_data_ready_page.sql", "102_rules_v2_rule_gap_page.sql",
    "103_product_reference_tokens.sql", "104_product_reference_lookup.sql"]) {
    await db.query(await readFile(`src/infrastructure/db/migrations/${name}`, "utf8"));
  }
  for (let id = 1; id <= 6; id++) {
    await db.query("INSERT INTO source_products VALUES($1,1,$2,$2)", [id, String(id)]);
    const brand = id === 1 ? "\ufeff ＮＩＫＥ \n" : id === 2 || id === 4 || id === 5 ? "Nike" : "Adidas";
    const category = id === 5 ? "hats" : "tops";
    const candidates = { "product.brand": [{ sourceValue: brand, context: {} }], "product.model": [],
      "product.category": [{ sourceValue: category, context: {} }] };
    const data = { referenceCandidates: [{ typeCode: "brand", sourceValue: brand },
      { typeCode: "category", sourceValue: category }], title: String(id) };
    await db.query("INSERT INTO internal_products(source_product_id,data,updated_at) VALUES($1,$2,NOW())", [id, data]);
    if (id === 4) continue; // newly processed, not indexed yet
    await db.query(`INSERT INTO rules_v2_workbench_items(source_product_id,target_id,source_id,rules_revision,
      product_updated_at,status,issue_count,issue_codes,search_text,title,result,blockers,conflicts,candidates,trace)
      VALUES($1,1,1,'0:0:',NOW(),'incomplete',1,ARRAY['required_brand_missing'],'', $2,'{}','[]','[]',$3,'[]')`,
    [id, String(id), candidates]);
  }
  await db.query("UPDATE internal_products SET data=data||$1::JSONB WHERE source_product_id=3", [{
    referenceCandidates: [{ typeCode: "brand", sourceValue: "Nike" }, { typeCode: "category", sourceValue: "tops" }],
  }]);
  await db.query("UPDATE internal_products SET data=$1 WHERE source_product_id=6", [{}]); // dirty invalid DTO
  const parameters: unknown[] = ["1", "1"];
  const predicate = indexedRulePredicate({ conditionGroups: [
    { conditions: [{ field: "candidate.brand.sourceValue", operator: "equals", values: ["Nike"] }] },
    { conditions: [{ field: "candidate.category.sourceValue", operator: "equals", values: ["tops"] }] },
  ] }, parameters)!;
  const sql = indexedCandidatePageSql(predicate, null, 500, "DESC", "$2");
  const result = await db.query(sql, parameters);
  assert.deepEqual(result.rows.map((row: { id: string }) => row.id), ["4", "3", "2", "1"]);
  assert.equal(result.rows.some((row: { id: string }) => row.id === "6"), false);
  parameters.push("3");
  const next = await db.query(indexedCandidatePageSql(predicate, "$5", 500, "DESC", "$2"), parameters);
  assert.deepEqual(next.rows.map((row: { id: string }) => row.id), ["2", "1"]);
  for (const direction of ["ASC", "DESC"] as const) {
    const seen: string[] = [];
    let cursor: string | null = null;
    while (true) {
      const values = parameters.slice(0, 4);
      if (cursor !== null) values.push(cursor);
      const page: { rows: { id: string }[] } = await db.query(
        indexedCandidatePageSql(predicate, cursor === null ? null : "$5", 2, direction, "$2"), values);
      if (page.rows.length === 0) break;
      const ids: string[] = page.rows.map((row) => row.id);
      seen.push(...ids);
      cursor = ids.at(-1)!;
    }
    assert.deepEqual(seen, direction === "DESC" ? ["4", "3", "2", "1"] : ["1", "2", "3", "4"]);
  }

  await db.query("INSERT INTO rules_v2_workbench_state(source_id,target_id,rules_revision,complete) VALUES(1,1,'0:0:',TRUE)");
  const adapter: SqlPool = { connect: async () => ({ query: (q, values) => db.query(q, values), release() {} }), async end() {} };
  const service = new RulesV2PreviewService(adapter);
  const page = await service.workbench({ sourceId: "1", targetId: "1", sort: "data_ready", variants: "with", limit: 2, offset: 1 });
  assert.equal(page.filteredCount, 3);
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items.map((item) => item.sourceProductId), ["2", "1"]);
  const gaps = await service.workbench({ sourceId: "1", targetId: "1", sort: "rule_gaps", missingField: "brand", limit: 2, offset: 1 });
  assert.equal(gaps.filteredCount, 3);
  assert.deepEqual(gaps.items.map((item) => item.sourceProductId), ["2", "1"]);
  console.info(JSON.stringify({ passed: true, migrations: 6, normalizedLookup: true, dirtyAndMissingIncluded: true,
    cursorPagination: true, workbenchPagination: true, exactCounts: true }));
} finally { await db.close(); }
