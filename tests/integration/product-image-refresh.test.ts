import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresProductImageRefreshRepository } from "../../src/infrastructure/db/repositories/postgres-product-image-refresh-repository.js";
import { PostgresJobRepository } from "../../src/infrastructure/db/repositories/postgres-job-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const schema = `image_refresh_${randomUUID().replaceAll("-", "")}`;

integration("image refresh queue with PostgreSQL", () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const checks = new PostgresProductImageRefreshRepository(pool);
  const jobs = new PostgresJobRepository(pool);
  const payload = { sourceProductId: "1", targetId: "3", externalId: "100" };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE source_products(id BIGINT PRIMARY KEY);
      INSERT INTO source_products VALUES(1);
      CREATE TABLE jobs(id BIGSERIAL PRIMARY KEY,job_type TEXT NOT NULL,payload JSONB NOT NULL,
        status TEXT NOT NULL,available_at TIMESTAMPTZ NOT NULL,unique_key TEXT NOT NULL,
        locked_by TEXT,updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT jobs_job_type_check CHECK(job_type IN('export_product')));
      CREATE UNIQUE INDEX jobs_active_unique_key_idx ON jobs(job_type,unique_key)
        WHERE status IN('pending','running','retry');`);
    await pool.query(await readFile("src/infrastructure/db/migrations/107_product_image_refresh.sql", "utf8"));
  });
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

  it("atomically schedules one check for concurrent inventory refreshes and enforces the interval", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => checks.enqueueDue(payload, 86_400_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const queued = await pool.query("SELECT job_type,payload FROM jobs");
    expect(queued.rows).toEqual([{ job_type: "check_product_images", payload }]);
    await pool.query("UPDATE jobs SET status='completed'");
    expect(await checks.enqueueDue(payload, 86_400_000)).toBe(false);
    await pool.query("UPDATE product_image_refresh_checks SET requested_at=NOW()-INTERVAL '2 days'");
    expect(await checks.enqueueDue(payload, 86_400_000)).toBe(true);
  });

  it("does not schedule another check while a media download is active", async () => {
    await pool.query("UPDATE jobs SET status='completed'; UPDATE product_image_refresh_checks SET requested_at=NOW()-INTERVAL '2 days'");
    await pool.query(`INSERT INTO jobs(job_type,payload,status,available_at,unique_key)
      VALUES('refresh_product_images',$1,'retry',NOW(),'source-product:1:images')`, [payload]);
    expect(await checks.enqueueDue(payload, 86_400_000)).toBe(false);
    await checks.recordCheck("1", "failed", "Image fetch failed");
    expect((await pool.query("SELECT status,last_error FROM product_image_refresh_checks")).rows[0])
      .toEqual({ status: "failed", last_error: "Image fetch failed" });
    await checks.recordCheck("1", "refreshed");
    expect((await pool.query("SELECT status,last_error FROM product_image_refresh_checks")).rows[0])
      .toEqual({ status: "refreshed", last_error: null });
  });

  it("persists an accepted media submission only for the owning worker and rejects conflicting receipts", async () => {
    const job = await pool.query(`INSERT INTO jobs(job_type,payload,status,available_at,unique_key,locked_by)
      VALUES('export_product_images',$1,'running',NOW(),'images-export','owner') RETURNING id`, [payload]);
    const id = String(job.rows[0].id);
    const submission = { receipt: { jobId: 9, payloadHash: "a".repeat(64) }, exportedHash: "b".repeat(64), exportFingerprint: "c".repeat(64) };
    await expect(jobs.saveExportSubmission(id,"wrong",submission)).rejects.toThrow();
    await jobs.saveExportSubmission(id,"owner",submission); await jobs.saveExportSubmission(id,"owner",submission);
    await expect(jobs.saveExportSubmission(id,"owner",{ ...submission,exportedHash: "d".repeat(64) })).rejects.toThrow();
    expect((await pool.query("SELECT payload FROM jobs WHERE id=$1", [id])).rows[0].payload).toEqual({ ...payload, submission });
  });
});
