import { describe, expect, it } from "vitest";

import { RulesV2LegacyImporter } from "../../src/infrastructure/db/rules-v2-legacy-importer.js";
import type { SqlClient, SqlPool, SqlResult } from "../../src/infrastructure/db/index.js";

class FakeClient implements SqlClient {
  readonly calls: { readonly text: string; readonly values?: readonly unknown[] }[] = [];
  released = false;
  failOnLegacyInsert = false;

  async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<SqlResult<Row>> {
    this.calls.push(values === undefined ? { text } : { text, values });
    if (this.failOnLegacyInsert && text.startsWith("INSERT INTO rules_v2 ")) throw new Error("import failed");
    if (text.includes("FROM rules_v2 WHERE origin_kind <> 'native'")) {
      return { rows: [
        { origin_kind: "exact_mapping", amount: 2 },
        { origin_kind: "target_mapping", amount: 1 },
      ] as unknown as Row[], rowCount: 2 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void { this.released = true; }
}

function pool(client: FakeClient): SqlPool {
  return { connect: async () => client, end: async () => undefined };
}

describe("RulesV2LegacyImporter", () => {
  it("imports every legacy family in one audited transaction", async () => {
    const client = new FakeClient();
    const result = await new RulesV2LegacyImporter(pool(client)).sync("tester");

    expect(result.total).toBe(3);
    expect(result.counts.exact_mapping).toBe(2);
    expect(result.counts.target_mapping).toBe(1);
    expect(result.counts.reference_projection).toBe(0);
    expect(client.calls.filter((call) => call.text.startsWith("INSERT INTO rules_v2 "))).toHaveLength(6);
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
    expect(client.calls.some((call) => call.text.includes("rules_v2_import_runs"))).toBe(true);
    expect(client.calls.some((call) => call.text.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(client.calls.some((call) => call.text.includes("migrationSourceMissing"))).toBe(true);
    expect(client.calls.filter((call) => call.text.startsWith("INSERT INTO rules_v2 ")).every((call) => call.text.includes("manualOverride"))).toBe(true);
    expect(client.released).toBe(true);
  });

  it("rolls back the complete snapshot when one family fails", async () => {
    const client = new FakeClient();
    client.failOnLegacyInsert = true;

    await expect(new RulesV2LegacyImporter(pool(client)).sync("tester")).rejects.toThrow("import failed");
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });
});
