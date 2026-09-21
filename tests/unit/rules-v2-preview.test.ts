import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuleV2Draft, RuleV2Record } from "../../src/repositories/index.js";
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

  it("checks required fields after direct target rules have built the resulting DTO", async () => {
    const rule = (id: string, scope: string, label: string): RuleV2Record => ({
      id, sourceId: "1", sourceCode: "goat", targetId: "10", targetCode: "slamdunk",
      name: label, groupCode: `${scope.split(".").at(-1)}_${id}`, priority: 100, status: "shadow",
      conditionGroups: [{ conditions: [{ field: "common.source.productId", operator: "equals", values: ["2"] }] }],
      actions: [{ targetScope: scope, dictionaryValueId: id, externalValue: id, externalLabel: label, mode: "add" }],
      originKind: "native", originId: null, originRevision: "1", originPayload: {}, revision: "1", createdAt: "", updatedAt: "",
    });
    vi.spyOn(RulesV2Runtime.prototype, "snapshot").mockResolvedValue(new RulesV2Snapshot("1", [
      rule("31", "product.brand", "Nike"), rule("32", "product.brand", "Jordan Brand"),
      rule("41", "product.category", "Кроссовки"),
    ]));
    const query = async <Row extends Record<string, unknown>>(sql: string): Promise<SqlResult<Row>> => {
      const rows = sql.includes("FROM source_products product") ? [{
        id: "2", source_id: "1", source_key: "shoe", external_id: "100", code: "goat", updated_at: "2026-09-21",
        data: {
          sourceProductId: "2", title: "Nike Test", description: "Описание", sku: "S",
          images: [{ url: "https://img", position: 0, alt: "Nike Test", attributes: {} }],
          variants: [{ sourceVariantKey: "v", sku: "V", size: { sourceValue: "8", displayValue: "8" },
            price: { amount: "100", currency: "USD" }, inventory: { availability: "available" }, attributes: {} }],
          referenceCandidates: [{ key: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product",
            sourceValue: "Nike Test", context: {}, evidence: {} }], attributes: {}, metadata: {},
        },
      }] : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    };
    const pool = { connect: async () => ({ query, release() {} }), async end() {} } as SqlPool;

    await expect(new RulesV2PreviewService(pool).workbench({ sourceId: "1", targetId: "10", status: "all" }))
      .resolves.toMatchObject({
        mode: "resulting_target_dto",
        items: [{ status: "incomplete", result: { fields: {
          "product.brand": [{ label: "Nike" }, { label: "Jordan Brand" }], "product.category": [{ label: "Кроссовки" }],
        } }, blockers: [{ code: "required_model_missing" }] }],
      });
  });
});
