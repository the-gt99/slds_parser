import { describe, expect, it } from "vitest";
import { directRulesV2Conditions, directRulesV2Field } from "../../src/services/rules-v2-direct-fields.js";

describe("Rules v2 direct DTO fields", () => {
  it("maps shared values and GOAT context without adding GOAT fields to the common DTO", () => {
    expect(directRulesV2Field("candidate.model.sourceValue")).toBe("common.characteristics.model");
    expect(directRulesV2Field("candidate.model.context.brand")).toBe("common.characteristics.brand");
    expect(directRulesV2Field("candidate.model.context.family")).toBe("common.characteristics.family");
    expect(directRulesV2Field("candidate.category.context.productType")).toBe("product.attribute.productType");
    expect(directRulesV2Field("candidate.category.context.route")).toBe("product.metadata.route");
    expect(directRulesV2Field("candidate.merchandising_category.sourceValue")).toBe("product.attribute.categoryRaw");
  });
  it("does not silently rewrite fields whose exact meaning is unavailable", () => {
    expect(directRulesV2Field("candidate.activity.sourceValue")).toBeNull();
    expect(directRulesV2Field("candidate.category.context.ageGroups")).toBeNull();
    expect(directRulesV2Conditions({ actions: [{ kind: "resolve_reference", referenceType: "model", referenceValueId: "1",
      referenceValueCode: "one", referenceValueName: "One", resolutionStatus: "confirmed" }], conditionGroups: [{ conditions: [
      { field: "candidate.model.sourceValue", operator: "equals", values: ["Samba"] },
    ] }, { conditions: [
      { field: "candidate.model.context.ageGroups", operator: "equals", values: ["big_kids|little_kids"] },
    ] }] })).toBeNull();
  });
  it("requires a source candidate when old rules only check its context", () => {
    expect(directRulesV2Conditions({ actions: [{ kind: "resolve_reference", referenceType: "model", referenceValueId: "1",
      referenceValueCode: "one", referenceValueName: "One", resolutionStatus: "confirmed" }], conditionGroups: [{ conditions: [
      { field: "candidate.model.context.brand", operator: "equals", values: ["Nike"] },
    ] }] })).toEqual([{ conditions: [{ field: "common.characteristics.brand", operator: "equals", values: ["Nike"] }] },
      { conditions: [{ field: "common.characteristics.model", operator: "regex", values: [".+"] }] }]);
  });
});
