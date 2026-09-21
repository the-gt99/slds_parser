import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuleV2Draft } from "../../src/repositories/index.js";
import type { SqlPool, SqlResult } from "../../src/infrastructure/db/sql-executor.js";
import { RulesV2Runtime } from "../../src/infrastructure/db/rules-v2-runtime.js";
import { RulesV2Snapshot } from "../../src/services/rules-v2-snapshot.js";
import { RulesV2PreviewService } from "../../src/services/rules-v2-preview.js";

afterEach(() => vi.restoreAllMocks());

describe("RulesV2PreviewService", () => {
  it("evaluates a native rule against an unclassified product without reading legacy decisions", async () => {
    vi.spyOn(RulesV2Runtime.prototype, "snapshot").mockResolvedValue(new RulesV2Snapshot("1", []));
    const statements: string[] = [];
    const query = async <Row extends Record<string, unknown>>(sql: string): Promise<SqlResult<Row>> => {
      statements.push(sql);
      const rows = sql.includes("FROM target_dictionary_values")
        ? [{ id: "50", external_id: "70", name: "Sneakers", entity_type: "product_categories" }]
        : sql.includes("FROM source_products product")
          ? [{ id: "2", source_key: "shoe", external_id: "100", code: "goat", data: {
            sourceProductId: "2", title: "Nike Sneakers", description: "", sku: "S", images: [], variants: [],
            referenceCandidates: [], attributes: {}, metadata: {},
          } }] : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    };
    const pool = { connect: async () => ({ query, release() {} }), async end() {} } as SqlPool;
    const draft: RuleV2Draft = { sourceId: "1", targetId: "10", name: "Sneakers", groupCode: "category",
      priority: 100, status: "shadow", conditionGroups: [{ conditions: [{ field: "product.title",
        operator: "contains_phrase", values: ["Sneakers"] }] }],
      actions: [{ targetScope: "product.category", dictionaryValueId: "50", mode: "add" }] };
    await expect(new RulesV2PreviewService(pool).preview(draft)).resolves.toMatchObject({
      examined: 1, productCount: 1, conflicts: [], writes: false,
    });
    expect(statements.some((sql) => sql.includes("reference_values") || sql.includes("classification_candidates"))).toBe(false);
  });
});
