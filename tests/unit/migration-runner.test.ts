import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/infrastructure/db/index.js";
import type {
  SqlClient,
  SqlPool,
  SqlResult,
} from "../../src/infrastructure/db/index.js";

class FakeClient implements SqlClient {
  readonly queries: string[] = [];
  released = false;

  constructor(
    private readonly applied: readonly string[] = [],
    private readonly failingSql?: string,
  ) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    _values?: unknown[],
  ): Promise<SqlResult<Row>> {
    const normalized = text.trim();
    this.queries.push(normalized);

    if (normalized === this.failingSql) {
      throw new Error("migration failed");
    }

    const rows = normalized === "SELECT name FROM schema_migrations"
      ? this.applied.map((name) => ({ name }))
      : [];

    return { rows: rows as unknown as Row[], rowCount: rows.length };
  }

  release(): void {
    this.released = true;
  }
}

class FakePool implements SqlPool {
  constructor(readonly client: FakeClient) {}

  async connect(): Promise<SqlClient> {
    return this.client;
  }

  async end(): Promise<void> {}
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createMigrations(
  migrations: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "slds-migrations-"));
  temporaryDirectories.push(directory);

  await Promise.all(
    Object.entries(migrations).map(([name, sql]) =>
      writeFile(path.join(directory, name), sql, "utf8"),
    ),
  );

  return directory;
}

describe("runMigrations", () => {
  it("does not record or roll back a failed concurrent index build", async () => {
    const statement = "CREATE INDEX CONCURRENTLY IF NOT EXISTS lookup_idx ON products (id)";
    const directory = await createMigrations({ "100_index.sql": `-- migrate: concurrent-index\n${statement};` });
    const client = new FakeClient([], statement);
    await expect(runMigrations({ pool: new FakePool(client), migrationsDirectory: directory })).rejects.toThrow("migration failed");
    expect(client.queries).not.toContain("INSERT INTO schema_migrations (name) VALUES ($1)");
    expect(client.queries).not.toContain("ROLLBACK");
    expect(client.released).toBe(true);
  });
  it("builds concurrent indexes outside a transaction and records only success", async () => {
    const directory = await createMigrations({ "100_index.sql":
      "-- migrate: concurrent-index\nCREATE INDEX CONCURRENTLY IF NOT EXISTS lookup_idx ON products (id);" });
    const client = new FakeClient();
    await expect(runMigrations({ pool: new FakePool(client), migrationsDirectory: directory })).resolves.toEqual(["100_index.sql"]);
    expect(client.queries).not.toContain("BEGIN");
    expect(client.queries).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS lookup_idx ON products (id)");
    expect(client.queries).toContain("INSERT INTO schema_migrations (name) VALUES ($1)");
  });

  it("rebuilds an invalid leftover index before retrying a concurrent migration", async () => {
    const directory = await createMigrations({ "100_index.sql":
      "-- migrate: concurrent-index\nCREATE INDEX CONCURRENTLY IF NOT EXISTS lookup_idx ON products (id);" });
    const client = new FakeClient();
    const baseQuery = client.query.bind(client);
    client.query = async <Row extends QueryResultRow>(sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT indisvalid")) return { rows: [{ indisvalid: false }] as unknown as Row[], rowCount: 1 };
      return baseQuery<Row>(sql, values);
    };
    await runMigrations({ pool: new FakePool(client), migrationsDirectory: directory });
    expect(client.queries).toContain('DROP INDEX CONCURRENTLY "lookup_idx"');
  });

  it("rejects multiple commands in a concurrent migration before changing schema", async () => {
    const directory = await createMigrations({ "100_index.sql":
      "-- migrate: concurrent-index\nCREATE INDEX CONCURRENTLY IF NOT EXISTS lookup_idx ON products (id); SELECT 1;" });
    const client = new FakeClient();
    await expect(runMigrations({ pool: new FakePool(client), migrationsDirectory: directory })).rejects.toThrow("exactly one");
    expect(client.queries.some((sql) => sql.startsWith("CREATE INDEX"))).toBe(false);
  });
  it("applies SQL files in filename order", async () => {
    const directory = await createMigrations({
      "002_second.sql": "SELECT 'second'",
      "001_first.sql": "SELECT 'first'",
    });
    const client = new FakeClient();

    await expect(
      runMigrations({ pool: new FakePool(client), migrationsDirectory: directory }),
    ).resolves.toEqual(["001_first.sql", "002_second.sql"]);
    expect(client.queries.indexOf("SELECT 'first'"))
      .toBeLessThan(client.queries.indexOf("SELECT 'second'"));
  });

  it("skips an already applied migration", async () => {
    const directory = await createMigrations({
      "001_applied.sql": "SELECT 'do not run'",
      "002_pending.sql": "SELECT 'run'",
    });
    const client = new FakeClient(["001_applied.sql"]);

    await expect(
      runMigrations({ pool: new FakePool(client), migrationsDirectory: directory }),
    ).resolves.toEqual(["002_pending.sql"]);
    expect(client.queries).not.toContain("SELECT 'do not run'");
    expect(client.queries).toContain("SELECT 'run'");
  });

  it("rolls back a failed migration", async () => {
    const directory = await createMigrations({
      "001_failing.sql": "SELECT 'fail'",
    });
    const client = new FakeClient([], "SELECT 'fail'");

    await expect(
      runMigrations({ pool: new FakePool(client), migrationsDirectory: directory }),
    ).rejects.toThrow("migration failed");
    expect(client.queries).toContain("ROLLBACK");
    expect(client.queries).not.toContain("COMMIT");
  });

  it("releases the advisory lock and client after an error", async () => {
    const directory = await createMigrations({
      "001_failing.sql": "SELECT 'fail'",
    });
    const client = new FakeClient([], "SELECT 'fail'");

    await expect(
      runMigrations({ pool: new FakePool(client), migrationsDirectory: directory }),
    ).rejects.toThrow();
    expect(client.queries).toContain("SELECT pg_advisory_unlock($1)");
    expect(client.released).toBe(true);
  });
});
