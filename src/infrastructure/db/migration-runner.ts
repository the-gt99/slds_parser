import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { SqlPool } from "./sql-executor.js";

const MIGRATION_LOCK_KEY = 7_314_592_041;

interface AppliedMigrationRow {
  readonly name: string;
}

export interface MigrationRunnerOptions {
  readonly pool: SqlPool;
  readonly migrationsDirectory: string;
}

export async function runMigrations({
  pool,
  migrationsDirectory,
}: MigrationRunnerOptions): Promise<readonly string[]> {
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort(compareMigrationNames);
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const appliedResult = await client.query<AppliedMigrationRow>(
        "SELECT name FROM schema_migrations",
      );
      const appliedNames = new Set(appliedResult.rows.map(({ name }) => name));
      const appliedNow: string[] = [];

      for (const name of migrationNames) {
        if (appliedNames.has(name)) {
          continue;
        }

        const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
        if (sql.startsWith("-- migrate: concurrent-index")) {
          const statement = sql.replace(/^-- migrate: concurrent-index\s*/u, "").trim().replace(/;$/u, "");
          const indexName = /^CREATE INDEX CONCURRENTLY IF NOT EXISTS ([a-z][a-z0-9_]*)\s+ON\s/iu.exec(statement)?.[1];
          if (indexName === undefined || statement.includes(";")) {
            throw new Error(`Concurrent migration must contain exactly one named CREATE INDEX: ${name}`);
          }
          const existing = await client.query<{ indisvalid: boolean }>(
            "SELECT indisvalid FROM pg_index WHERE indexrelid = TO_REGCLASS($1)", [indexName]);
          if (existing.rows[0]?.indisvalid === false) {
            // PostgreSQL leaves an invalid index after an interrupted concurrent build.
            await client.query(`DROP INDEX CONCURRENTLY "${indexName}"`);
          }
          await client.query(statement);
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
          appliedNow.push(name);
          continue;
        }
        await client.query("BEGIN");

        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (name) VALUES ($1)",
            [name],
          );
          await client.query("COMMIT");
          appliedNow.push(name);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }

      return appliedNow;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

function compareMigrationNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
