import { describe, expect, it } from "vitest";
import type { UniversalProductDTO } from "../../src/contracts/index.js";
import { DirectRulesV2Index, directRulesV2Conditions, directRulesV2Field, matchesDirectRulesV2Conditions } from "../../src/services/rules-v2-direct-fields.js";

const product: UniversalProductDTO = { sourceProductId: "1", title: "Air Jordan", description: "", sku: "A",
  images: [], variants: [], attributes: {}, metadata: {}, referenceCandidates: [] };

describe("Rules v2 direct DTO fields", () => {
  it("maps shared values and GOAT context without adding GOAT fields to the common DTO", () => {
    expect(directRulesV2Field("candidate.model.sourceValue")).toBe("common.characteristics.model");
    expect(directRulesV2Field("candidate.model.context.brand")).toBe("common.characteristics.brand");
    expect(directRulesV2Field("candidate.model.context.family")).toBe("common.characteristics.family");
    expect(directRulesV2Field("candidate.category.context.productType")).toBe("product.attribute.productType");
    expect(directRulesV2Field("candidate.category.context.route")).toBe("product.metadata.route");
    expect(directRulesV2Field("candidate.merchandising_category.sourceValue")).toBe("product.attribute.categoryRaw");
  });
  it("keeps explicit activity, shoe height and ordered age groups", () => {
    expect(directRulesV2Field("candidate.activity.sourceValue")).toBe("common.characteristics.activities");
    expect(directRulesV2Field("candidate.shoe_height.sourceValue")).toBe("common.characteristics.shoeHeight");
    expect(directRulesV2Field("candidate.category.context.ageGroups")).toBe("product.attribute.ageGroupsJoined");
    expect(directRulesV2Field("candidate.category.context.unknown")).toBeNull();
  });
  it("requires a source candidate when old rules only check its context", () => {
    expect(directRulesV2Conditions({ actions: [{ kind: "resolve_reference", referenceType: "model", referenceValueId: "1",
      referenceValueCode: "one", referenceValueName: "One", resolutionStatus: "confirmed" }], conditionGroups: [{ conditions: [
      { field: "candidate.model.context.brand", operator: "equals", values: ["Nike"] },
    ] }] })).toEqual([{ conditions: [{ field: "common.characteristics.brand", operator: "equals", values: ["Nike"] }] },
      { conditions: [{ field: "common.characteristics.model", operator: "regex", values: [".+"] }] }]);
  });
  it("retains imported contains, all_words and regex behavior", () => {
    const read = (field: string) => field === "common.title" ? [product.title] : [];
    expect(matchesDirectRulesV2Conditions(product, [{ conditions: [
      { field: "common.title", operator: "contains" as never, values: ["ir Jor"] },
    ] }], read)).toBe(true);
    expect(matchesDirectRulesV2Conditions(product, [{ conditions: [
      { field: "common.title", operator: "all_words" as never, values: ["Jordan Air"] },
    ] }], read)).toBe(true);
    expect(matchesDirectRulesV2Conditions(product, [{ conditions: [
      { field: "common.title", operator: "regex", values: ["(?<=Air )Jordan"] },
    ] }], read)).toBe(true);
  });
  it("indexes necessary exact groups without losing OR branches", () => {
    const entries = [
      { id: "one", groups: [{ conditions: [{ field: "common.title", operator: "equals" as const, values: ["Nike"] },
        { field: "common.sku", operator: "equals" as const, values: ["X"] }] }] },
      { id: "two", groups: [{ conditions: [{ field: "common.title", operator: "equals" as const, values: ["Adidas"] }] }] },
      { id: "general", groups: [{ conditions: [{ field: "common.title", operator: "contains_phrase" as const, values: ["Air"] }] }] },
    ];
    const index = new DirectRulesV2Index(entries);
    expect(index.select((field) => field === "common.sku" ? ["x"] : ["Puma"]).map((entry) => entry.id))
      .toEqual(["one", "general"]);
    expect(index.select((field) => field === "common.title" ? ["adidas"] : []).map((entry) => entry.id))
      .toEqual(["two", "general"]);
  });
});
