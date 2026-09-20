import assert from "node:assert/strict";
import { createPostgresPool } from "../../src/infrastructure/db/index.js";
import { PostgresRulesV2Repository } from "../../src/infrastructure/db/repositories/postgres-rules-v2-repository.js";
import { RulesV2LegacyImporter } from "../../src/infrastructure/db/rules-v2-legacy-importer.js";
import type { SqlPool, SqlExecutor } from "../../src/infrastructure/db/sql-executor.js";

// Manual integration check: all writable relations are session-local TEMP copies.
// Shared dictionaries and legacy rules are only read. Closing the connection removes the copies.
if (process.env.RULES_V2_TEMP_SQL_SMOKE !== "1") throw new Error("Explicit RULES_V2_TEMP_SQL_SMOKE=1 is required");
const pool = createPostgresPool();
const client = await pool.connect();
try {
  await client.query("SET statement_timeout = '60s'");
  for (const table of ["rules_v2", "rules_v2_history", "rules_v2_import_runs"] as const) {
    await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await client.query(`CREATE TEMP SEQUENCE ${table}_smoke_seq`);
    await client.query(`ALTER TABLE pg_temp.${table} ALTER COLUMN id SET DEFAULT nextval('pg_temp.${table}_smoke_seq')`);
  }
  await client.query("INSERT INTO pg_temp.rules_v2 SELECT * FROM public.rules_v2");
  await client.query("SELECT setval('pg_temp.rules_v2_smoke_seq', COALESCE((SELECT MAX(id) FROM pg_temp.rules_v2), 0) + 1, FALSE)");
  const temporaryPool: SqlPool & SqlExecutor = {
    query: (sql, values) => client.query(sql, values),
    connect: async () => ({ query: (sql, values) => client.query(sql, values), release() {} }),
    async end() {},
  };
  const repository = new PostgresRulesV2Repository(temporaryPool);
  const before = await repository.summary();
  assert.ok(before.catalog!.total > 0);
  const page = await repository.list(undefined, { limit: 10 });
  assert.ok(page.length <= 10);
  const source = (await client.query<{ id: string }>("SELECT id::TEXT FROM sources ORDER BY id LIMIT 1")).rows[0]!;
  const dictionary = (await client.query<{ id: string; target_id: string }>("SELECT id::TEXT, target_id::TEXT FROM target_dictionary_values WHERE active AND entity_type = 'product_categories' ORDER BY id LIMIT 1")).rows[0]!;
  const native = await repository.create({ sourceId: source.id, targetId: dictionary.target_id, name: "Проверка временной копии", groupCode: "smoke", priority: 17, status: "draft",
    conditionGroups: [{ conditions: [{ field: "common.title", operator: "regex", values: ["adidas.{1,3}Samba"] }, { field: "common.title", operator: "equals", values: ["Samba"] }] },
      { conditions: [{ field: "common.characteristics.audience", operator: "equals", values: ["men"] }] }],
    actions: [{ targetScope: "product.category", dictionaryValueId: dictionary.id, mode: "replace" }, { targetScope: "product.category", dictionaryValueId: dictionary.id, mode: "add" }],
  }, "temporary-sql-smoke");
  assert.equal(native.conditionGroups.length, 2);
  assert.equal(native.actions.length, 2);
  assert.equal(native.conditionGroups[0]!.conditions[0]!.values[0], "adidas.{1,3}Samba");
  const candidate = (await repository.list(undefined, { search: "", limit: 100000 })).find((r) => r.originKind === "classification_rule" && r.status === "shadow");
  assert.ok(candidate, "An enabled imported classification rule is required");
  const updated = await repository.updateImported(candidate.id, { ...candidate, name: candidate.name + " (проверка)", priority: candidate.priority + 1 }, candidate.revision, "temporary-sql-smoke");
  assert.equal(updated.originPayload.manualOverride, true);
  await assert.rejects(repository.updateImported(candidate.id, { ...candidate }, candidate.revision, "temporary-sql-smoke"), /another operator/);
  await new RulesV2LegacyImporter(temporaryPool).sync("temporary-sql-smoke");
  const after = (await repository.list(undefined, { search: updated.name, limit: 100 })).find((r) => r.id === updated.id);
  assert.equal(after?.revision, updated.revision);
  assert.equal(after?.priority, updated.priority);
  assert.equal(after?.name, updated.name);
  console.info(JSON.stringify({ passed: true, temporaryTablesOnly: true, catalog: before.catalog, nativeRoundTrip: true, importedEdit: true, optimisticRevision: true, manualOverrideSurvivesImport: true }));
} finally { client.release(); await pool.end(); }
