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
