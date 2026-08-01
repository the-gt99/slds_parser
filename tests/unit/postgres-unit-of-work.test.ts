import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresUnitOfWork } from "../../src/infrastructure/db/index.js";
import type { SqlClient, SqlPool, SqlResult } from "../../src/infrastructure/db/index.js";

class FakeClient implements SqlClient {
  readonly queries: string[] = [];
  released = false;
  async query<Row extends QueryResultRow = QueryResultRow>(text: string): Promise<SqlResult<Row>> {
    this.queries.push(text);
    return { rows: [], rowCount: 0 };
  }
  release(): void { this.released = true; }
}

class FakePool implements SqlPool {
  constructor(readonly client: FakeClient) {}
  async connect(): Promise<SqlClient> { return this.client; }
  async end(): Promise<void> {}
}

describe("PostgresUnitOfWork", () => {
  it("commits and releases its dedicated client", async () => {
    const client = new FakeClient();
    const result = await new PostgresUnitOfWork(new FakePool(client)).transaction(async (repositories) => {
      expect(repositories.sources).toBeDefined();
      return "result";
    });
    expect(result).toBe("result");
    expect(client.queries).toEqual(["BEGIN", "COMMIT"]);
    expect(client.released).toBe(true);
  });

  it("rolls back, releases the client and rethrows the original error", async () => {
    const client = new FakeClient();
    const original = new Error("callback failed");
    const promise = new PostgresUnitOfWork(new FakePool(client)).transaction(async () => { throw original; });
    await expect(promise).rejects.toBe(original);
    expect(client.queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.released).toBe(true);
  });
});
