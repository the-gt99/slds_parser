import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresImageMirrorQueue } from "../../src/infrastructure/media/image-mirror.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const schema = `mirror_${randomUUID().replaceAll("-", "")}`;
integration("image mirror PostgreSQL outbox", () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const queue = new PostgresImageMirrorQueue(pool, "destination");
  const request = { key: "parser/image.webp", sha256: "a".repeat(64), size: 42 };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE jobs(id BIGSERIAL PRIMARY KEY,job_type TEXT NOT NULL,payload JSONB NOT NULL,
      status TEXT NOT NULL,available_at TIMESTAMPTZ NOT NULL,unique_key TEXT NOT NULL,
      CONSTRAINT jobs_job_type_check CHECK(job_type IN('export_product')))`);
    await pool.query(await readFile("src/infrastructure/db/migrations/111_image_mirror.sql", "utf8"));
  });
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  it("atomically persists one job under concurrent publication and survives job retention", async () => {
    await Promise.all(Array.from({ length: 12 }, () => queue.enqueue(request)));
    expect((await pool.query("SELECT payload FROM jobs")).rows).toEqual([{ payload: { ...request, destinationId: "destination" } }]);
    await queue.complete(request);
    await pool.query("DELETE FROM jobs");
    await queue.enqueue(request);
    expect((await pool.query("SELECT count(*) FROM jobs")).rows[0].count).toBe("0");
    expect((await pool.query("SELECT copied_at FROM image_mirror_objects")).rows[0].copied_at).toBeTruthy();
    await expect(queue.enqueue({ ...request, sha256: "b".repeat(64) })).rejects.toThrow("different content");
  });
  it("rolls back the receipt if job insertion fails", async () => {
    await pool.query("ALTER TABLE jobs ADD CONSTRAINT reject_job CHECK (job_type <> 'mirror_image')");
    await expect(queue.enqueue({ ...request, key: "second" })).rejects.toThrow();
    expect((await pool.query("SELECT count(*) FROM image_mirror_objects WHERE object_key='second'")).rows[0].count).toBe("0");
  });
});
