import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { SqlPool } from "../../src/infrastructure/db/sql-executor.js";
import { PostgresWordPressCatalogRepository } from "../../src/infrastructure/db/repositories/postgres-wordpress-catalog-repository.js";

const modulePath = process.env.INVENTORY_QUERY_PGLITE_MODULE;
if (modulePath === undefined) throw new Error("INVENTORY_QUERY_PGLITE_MODULE is required");
const { PGlite } = await import(pathToFileURL(modulePath).href);
const db = new PGlite();
try {
  await db.exec(`
    CREATE TABLE wordpress_catalog_runs(id BIGINT PRIMARY KEY, goat_inventory_status TEXT, shihuo_inventory_status TEXT);
    CREATE TABLE wordpress_catalog_run_items(id BIGINT PRIMARY KEY, run_id BIGINT, match_status TEXT,
      internal_product_id BIGINT, wordpress_product_id BIGINT);
    CREATE TABLE wordpress_inventory_donor_states(item_id BIGINT, run_id BIGINT, donor_code TEXT,
      checked_at TIMESTAMPTZ, PRIMARY KEY(item_id,donor_code));
    CREATE TABLE jobs(id BIGSERIAL PRIMARY KEY,job_type TEXT,payload JSONB,status TEXT,unique_key TEXT,finished_at TIMESTAMPTZ);
    CREATE UNIQUE INDEX jobs_active_unique_key_idx ON jobs(job_type,unique_key) WHERE status IN('pending','running','retry');
    INSERT INTO wordpress_catalog_runs VALUES(4,'running','running');
    INSERT INTO wordpress_catalog_run_items VALUES
      (1,4,'matched',1,101),(2,4,'matched',2,102),(3,4,'matched',3,103),(4,4,'matched',4,104),(5,4,'unmatched',NULL,105);
    INSERT INTO wordpress_inventory_donor_states VALUES(2,4,'goat',NOW()-INTERVAL '1 day');
    INSERT INTO jobs(job_type,payload,status,unique_key,finished_at) VALUES
      ('collect_wordpress_goat_inventory','{"runId":"4","itemId":"3"}','failed','failed-3',NOW()),
      ('collect_wordpress_goat_inventory','{"runId":"4","itemId":"4"}','pending','active-4',NULL);
  `);
  const adapter: SqlPool = { connect: async () => ({ query: (q, values) => db.query(q, values), release() {} }), async end() {} };
  let clock = 1_000;
  const repository = new PostgresWordPressCatalogRepository(adapter, () => clock);
  const input = { runId: "4", donorCode: "goat", limit: 10, intervalMinutes: 30 } as const;
  assert.equal(await repository.enqueueDueInventoryDonorJobs(input), 2);
  const ids = async () => (await db.query(`SELECT payload->>'itemId' AS id FROM jobs
    WHERE job_type='collect_wordpress_goat_inventory' AND status='pending' ORDER BY (payload->>'itemId')::BIGINT`)).rows.map((r: { id: string }) => r.id);
  assert.deepEqual(await ids(), ["1", "2", "4"]);
  await db.exec(`UPDATE jobs SET status='completed' WHERE status='pending';
    INSERT INTO wordpress_inventory_donor_states VALUES(1,4,'goat',NOW()),(4,4,'goat',NOW());
    INSERT INTO wordpress_catalog_run_items VALUES(6,4,'matched',6,106);`);
  // A new missing item waits at most one minute; stale inventory is not paused.
  assert.equal(await repository.enqueueDueInventoryDonorJobs(input), 1);
  assert.deepEqual(await ids(), ["2"]);
  await db.exec("UPDATE jobs SET status='completed' WHERE status='pending'");
  clock += 60_000;
  assert.equal(await repository.enqueueDueInventoryDonorJobs(input), 2);
  assert.deepEqual(await ids(), ["2", "6"]);
  assert.equal(await repository.enqueueDueInventoryDonorJobs({ ...input, donorCode: "shihuo" }), 5);
  console.info(JSON.stringify({ passed: true, missingAndStale: true, recentFailuresBlocked: true,
    activeJobsBlocked: true, throttleKeepsStaleFlowing: true, newItemsRechecked: true, independentDonors: true }));
} finally { await db.close(); }
