import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SqlPool } from "../../src/infrastructure/db/sql-executor.js";
import { PostgresWordPressCatalogRepository } from "../../src/infrastructure/db/repositories/postgres-wordpress-catalog-repository.js";
const modulePath = process.env.INVENTORY_QUERY_PGLITE_MODULE;
if (!modulePath) throw new Error("INVENTORY_QUERY_PGLITE_MODULE is required");
const { PGlite } = await import(pathToFileURL(modulePath).href);
const db = new PGlite();
try {
  await db.exec(`CREATE TABLE wordpress_catalog_runs(id BIGINT PRIMARY KEY,variation_auto_status TEXT);
    CREATE TABLE wordpress_catalog_run_items(id BIGINT PRIMARY KEY,run_id BIGINT,wordpress_product_id BIGINT,
      wordpress_job_id BIGINT,variation_status TEXT,variation_source_hash TEXT,updated_at TIMESTAMPTZ,
      variation_payload JSONB,variation_error TEXT,variation_notices JSONB);
    CREATE TABLE jobs(id BIGSERIAL PRIMARY KEY,job_type TEXT,payload JSONB,status TEXT,unique_key TEXT);
    CREATE UNIQUE INDEX jobs_active_unique_key_idx ON jobs(job_type,unique_key) WHERE status IN('pending','running','retry');
    INSERT INTO wordpress_catalog_runs VALUES(4,'running'),(5,'paused');
    INSERT INTO wordpress_catalog_run_items SELECT id,4,id+1000,NULL,'pending',NULL,NOW()-INTERVAL '1 hour',NULL,NULL,'[]'
      FROM generate_series(1,1001) id;
    INSERT INTO jobs(job_type,payload,status,unique_key) SELECT 'combine_wordpress_inventory',
      jsonb_build_object('runId','4','itemId',id::TEXT),'running','active-'||id FROM generate_series(1,1000) id;
    INSERT INTO jobs(job_type,payload,status,unique_key) VALUES
      ('prepare_wordpress_variation_patch','{"runId":"4"}','pending','null-id');`);
  await db.exec((await readFile(new URL("../../src/infrastructure/db/migrations/110_inventory_recovery_candidates.sql", import.meta.url), "utf8"))
    .replace("CONCURRENTLY ", ""));
  const adapter: SqlPool = { connect: async () => ({ query: (q, values) => db.query(q, values), release() {} }), async end() {} };
  const repository = new PostgresWordPressCatalogRepository(adapter);
  assert.equal(await repository.recoverOrphanedVariationItems("4"), 0);
  assert.equal(await repository.recoverOrphanedVariationItems("4"), 1);
  assert.equal((await db.query("SELECT variation_status FROM wordpress_catalog_run_items WHERE id=1001")).rows[0].variation_status, "skipped");
  await db.exec(`UPDATE wordpress_catalog_run_items SET variation_status='submitted',wordpress_job_id=55,updated_at=NOW()-INTERVAL '1 hour' WHERE id=1001;
    INSERT INTO jobs(job_type,payload,status,unique_key) VALUES('poll_wordpress_variation_patches','{"runId":"4","jobIds":["55",null]}','pending','existing-poll');`);
  assert.equal(await repository.recoverOrphanedVariationItems("4"), 0);
  assert.equal(await repository.recoverOrphanedVariationItems("4"), 0);
  await db.exec("UPDATE jobs SET status='completed' WHERE job_type='poll_wordpress_variation_patches'");
  assert.equal(await repository.recoverOrphanedVariationItems("4"), 0);
  assert.equal(await repository.recoverOrphanedVariationItems("4"), 1);
  assert.equal(Number((await db.query("SELECT count(*) AS count FROM jobs WHERE job_type='poll_wordpress_variation_patches' AND status='pending'")).rows[0].count), 1);
  console.info(JSON.stringify({ passed: true, protectedActiveJobs: true, nullSafe: true, reachedTail: true, recoveredPoll: true }));
} finally { await db.close(); }
