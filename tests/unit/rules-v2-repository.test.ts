import { describe, expect, it } from "vitest";

import { PostgresRulesV2Repository } from "../../src/infrastructure/db/repositories/postgres-rules-v2-repository.js";
import type { SqlClient, SqlExecutor, SqlPool, SqlResult } from "../../src/infrastructure/db/index.js";
import type { RuleV2Draft } from "../../src/repositories/index.js";

const draft: RuleV2Draft = {
  sourceId: "1", targetId: "10", name: "Топы", groupCode: "category", priority: 100, status: "shadow",
  conditionGroups: [{ conditions: [{ field: "product.title", operator: "equals", values: ["Tops"] }] }],
  actions: [{ targetScope: "product.category", dictionaryValueId: "99", mode: "add" }],
};

describe("PostgresRulesV2Repository", () => {
  it("rejects editing an imported copy before changing any rule data", async () => {
    const statements: string[] = [];
    const client: SqlClient = {
      query: async <Row extends Record<string, unknown>>(sql: string): Promise<SqlResult<Row>> => {
        statements.push(sql);
        if (sql.startsWith("SELECT * FROM rules_v2")) return { rows: [{ origin_kind: "classification_projection", revision: 1 }] as unknown as Row[], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client, query: client.query } as SqlPool & SqlExecutor;

    await expect(new PostgresRulesV2Repository(pool).update("46", draft, "1", "admin"))
      .rejects.toThrow("Imported shadow copies are read-only");
    expect(statements).toEqual(["BEGIN", "SELECT * FROM rules_v2 WHERE id = $1 FOR UPDATE", "ROLLBACK"]);
  });
});
