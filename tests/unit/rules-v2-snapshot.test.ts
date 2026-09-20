import { describe, expect, it } from "vitest";
import type { UniversalProductDTO } from "../../src/contracts/index.js";
import type { RuleV2Record } from "../../src/repositories/index.js";
import { RulesV2Snapshot, rulesV2FieldReader } from "../../src/services/rules-v2-snapshot.js";

const source = { id: "1", code: "goat", productId: "10", sourceKey: "adidas", externalId: null };
const product: UniversalProductDTO = { sourceProductId: "10", title: "adidas Samba", description: "", sku: "SKU",
  images: [], variants: [], attributes: { audience: "men" }, metadata: {}, referenceCandidates: [] };
const action = { kind: "assign_target_term" as const, targetScope: "product.category", dictionaryValueId: "9",
  externalValue: "99", externalLabel: "Sneakers", mode: "replace" as const };
function rule(overrides: Partial<RuleV2Record> = {}): RuleV2Record {
  return { id: "1", sourceId: "1", sourceCode: "goat", targetId: "2", targetCode: "shop", name: "Test",
    groupCode: "category", priority: 100, status: "shadow", conditionGroups: [{ conditions: [
      { field: "common.title", operator: "equals", values: ["adidas Samba"] },
    ] }], actions: [action], originKind: "native", originId: null, originRevision: "1", originPayload: {},
    revision: "1", createdAt: "2026-09-20", updatedAt: "2026-09-20", ...overrides };
}
describe("Rules v2 compiled snapshot", () => {
  it("combines AND groups, OR branches and multiple actions on the common DTO", () => {
    const snapshot = new RulesV2Snapshot("1", [rule({ conditionGroups: [
      { conditions: [{ field: "common.title", operator: "equals", values: ["Nike"] },
        { field: "common.characteristics.audience", operator: "equals", values: ["MEN"] }] },
      { conditions: [{ field: "common.title", operator: "contains_phrase", values: ["adidas"] }] },
    ], actions: [action, { ...action, targetScope: "product.tag", mode: "add" }] })]);
    expect(snapshot.nativeAssignments("2", product, source)).toHaveLength(2);
    expect(snapshot.nativeAssignments("2", { ...product, attributes: { audience: "women" } }, source)).toEqual([]);
    expect(snapshot.nativeAssignments("2", product, { ...source, id: "other" })).toEqual([]);
    expect(snapshot.nativeAssignments("other", product, source)).toEqual([]);
  });
  it("uses priority across migrated and native assignment rules and rejects ties", () => {
    const old = rule({ originKind: "target_assignment_rule", originId: "500", sourceId: null, conditionGroups: [
      { conditions: [{ field: "product.title", operator: "equals", values: ["adidas Samba"] }] },
    ] });
    expect(new RulesV2Snapshot("1", [old, rule({ id: "2", priority: 200 })]).nativeAssignments("2", product, source)[0]?.ruleId).toBe("2");
    expect(() => new RulesV2Snapshot("1", [old, rule({ id: "2" })]).nativeAssignments("2", product, source)).toThrow("equally prioritized");
  });
  it("ignores drafts/disabled rules and keeps non-indexable regex conditions", () => {
    const regex = rule({ conditionGroups: [{ conditions: [{ field: "common.title", operator: "regex", values: ["^adidas"] }] }] });
    expect(new RulesV2Snapshot("1", [regex]).nativeAssignments("2", product, source)).toHaveLength(1);
    expect(new RulesV2Snapshot("1", [rule({ status: "draft" }), rule({ status: "disabled" })]).nativeAssignments("2", product, source)).toEqual([]);
  });
  it("looks up exact decisions by the full source/type/scope/value/context key including ignored outcomes", () => {
    const snapshot = new RulesV2Snapshot("1", [rule({ originKind: "exact_mapping", originId: "777", targetId: null,
      originPayload: { scope: "product.model", normalizedSourceValue: "samba", contextKey: '{"brand":"adidas"}' },
      actions: [{ kind: "resolve_reference", referenceType: "model", referenceValueId: null,
        referenceValueCode: null, referenceValueName: null, resolutionStatus: "ignored" }] })]);
    const input = { candidateKey: "model", typeCode: "model", scope: "product.model", normalizedSourceValue: "samba", contextKey: '{"brand":"adidas"}' };
    expect(snapshot.decisions("1", [input])).toEqual([{ candidateKey: "model", mappingId: "777", referenceValueId: null, status: "ignored", revision: "1" }]);
    expect(snapshot.decisions("2", [input])).toEqual([]);
    expect(snapshot.decisions("1", [{ ...input, contextKey: '{"brand":"adidas","extra":true}' }])).toEqual([]);
  });
  it("gates projections by the actual winning resolution, not their matching conditions", () => {
    const snapshot = new RulesV2Snapshot("1", [rule({ originKind: "classification_projection", originId: "15",
      originPayload: { sourceOrigin: { mappingId: "777", ruleId: null }, externalSlug: "samba", metadata: { managedBy: "target_term_relation" } } }),
      rule({ id: "2", originKind: "reference_projection", originId: "16", originPayload: { referenceValueId: "40" } })]);
    expect(snapshot.projections("2", [{ resolutionKind: "rule", resolutionId: "777", referenceId: "40" }]).map((p) => p.id)).toEqual(["16"]);
    const resolutions = [{ resolutionKind: "mapping" as const, resolutionId: "777", referenceId: "40" }];
    expect(snapshot.projections("2", [...resolutions, ...resolutions]).map((p) => p.id)).toEqual(["15", "16"]);
    expect(snapshot.projections("2", resolutions)[0]?.externalSlug).toBe("samba");
  });
  it("reads nested arrays and does not expose prototype properties", () => {
    const read = rulesV2FieldReader({ ...product, images: [{ url: "https://example.com/a", alt: "A", position: 0, attributes: {} }] }, source);
    expect(read("common.images.*.url")).toEqual(["https://example.com/a"]);
    expect(() => read("common.images.url")).toThrow("Unsupported");
    expect(read("common.source.code")).toEqual(["goat"]);
    expect(() => read("common.constructor.name")).toThrow("Unsupported");
  });
  it("reads family and age groups from common DTO while keeping donor taxonomy separate", () => {
    const read = rulesV2FieldReader({ ...product, attributes: { family: "Samba", ageGroups: ["adult", "youth"],
      taxonomy: { taxonomyLevel4: "Button Down Shirts" }, productType: "tops" }, metadata: { route: "apparel" } }, source);
    expect(read("common.characteristics.family")).toEqual(["Samba"]);
    expect(read("common.characteristics.ageGroups")).toEqual(["adult", "youth"]);
    expect(() => read("common.characteristics.productType")).toThrow("Unsupported");
    expect(read("product.attribute.productType")).toEqual(["tops"]);
    expect(read("product.attribute.taxonomy.taxonomyLevel4")).toEqual(["Button Down Shirts"]);
    expect(read("product.metadata.route")).toEqual(["apparel"]);
  });
  it("handles a large exact catalog without evaluating every rule per product", () => {
    const rules = Array.from({ length: 50_000 }, (_, index) => rule({ id: String(index + 1), conditionGroups: [
      { conditions: [{ field: "common.sku", operator: "equals", values: [`SKU-${index}`] }] },
    ] }));
    const snapshot = new RulesV2Snapshot("1", rules);
    expect(snapshot.nativeAssignments("2", { ...product, sku: "SKU-49999" }, source)).toHaveLength(1);
  });
});
