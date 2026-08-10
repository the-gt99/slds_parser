import { describe, expect, it } from "vitest";

import { suggestRuleConditions } from "../../public/classifier-rule-suggestions.js";

describe("classifier rule suggestions", () => {
  it("matches an activity by its explicit source value instead of the product title", () => {
    expect(suggestRuleConditions({
      typeCode: "activity",
      sourceValue: "Lifestyle",
      context: { brand: "Nike" },
      examples: [{ evidence: { title: "Nike Air Max Lifestyle" } }],
    })).toEqual([
      { field: "sourceValue", operator: "equals", value: "Lifestyle" },
    ]);
  });

  it("uses title evidence only for model recognition", () => {
    expect(suggestRuleConditions({
      typeCode: "model",
      sourceValue: "Air Max 1",
      context: { brand: "Nike" },
      examples: [{ evidence: { title: "Nike Air Max 1 'White'" } }],
    })).toEqual([
      { field: "context.brand", operator: "equals", value: "Nike" },
      { field: "evidence.title", operator: "contains", value: "Air Max 1" },
    ]);
  });
});
