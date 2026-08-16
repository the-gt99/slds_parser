import { describe, expect, it } from "vitest";

import type { UniversalProductDTO } from "../../src/contracts/index.js";
import type { TargetAssignmentRuleRecord } from "../../src/repositories/index.js";
import { resolveTargetAssignments } from "../../src/services/index.js";

const product = {
  sourceProductId: "1", title: "Sandal model", description: "", sku: "SKU", images: [], variants: [], attributes: { gender: "women" }, metadata: {},
  sourceFacts: { designer: "Wilson Smith" },
  referenceCandidates: [
    { key: "category", typeCode: "category", scope: "product.category", subjectKind: "product", sourceValue: "sandals", context: { audience: "women" }, evidence: {} },
    { key: "marketing", typeCode: "merchandising_category", scope: "product.merchandising_category", subjectKind: "product", sourceValue: "Sandal", context: {}, evidence: {} },
    { key: "model", typeCode: "model", scope: "product.model", subjectKind: "product", sourceValue: "Ronnie Fieg x Clarks x adidas 8th Street Samba", context: { brand: "adidas", family: "Samba" }, evidence: {} },
  ],
  classification: { status: "complete", classifierVersion: "1", fingerprint: "x", ignored: [], unresolved: [], resolved: [
    { candidateKey: "model", typeCode: "model", scope: "product.model", subjectKind: "product", referenceValueId: "500", resolutionKind: "mapping", resolutionId: "10", resolutionRevision: "1" },
  ] },
} satisfies UniversalProductDTO;

function rule(id: string, priority: number, conditions: TargetAssignmentRuleRecord["conditions"], externalValue: string): TargetAssignmentRuleRecord {
  return { id, targetId: "10", name: id, groupCode: "sandal_leaf", priority, conditions, actions: [{ targetScope: "product.category", dictionaryValueId: externalValue, externalValue, externalLabel: externalValue, mode: "replace" }], enabled: true, revision: "1", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
}

describe("target assignment rules", () => {
  it("lets a resolved model-set rule override the gender fallback", () => {
    const result = resolveTargetAssignments(product, [
      rule("fallback", 100, [
        { field: "candidate.category.sourceValue", operator: "equals", values: ["sandals"] },
        { field: "candidate.category.context.audience", operator: "equals", values: ["women"] },
      ], "75"),
      rule("special", 300, [
        { field: "candidate.category.sourceValue", operator: "equals", values: ["sandals"] },
        { field: "resolved.model", operator: "one_of", values: ["499", "500"] },
      ], "900"),
    ]);

    expect(result).toEqual([{ ruleId: "special", groupCode: "sandal_leaf", targetScope: "product.category", externalValue: "900", mode: "replace" }]);
  });

  it("rejects equally prioritized matches in one exclusive group", () => {
    const conditions = [{ field: "candidate.category.sourceValue", operator: "equals" as const, values: ["sandals"] }];
    expect(() => resolveTargetAssignments(product, [rule("a", 100, conditions, "1"), rule("b", 100, conditions, "2")]))
      .toThrow("equally prioritized");
  });

  it("matches an exact source model even before the model is resolved", () => {
    const unresolvedModelProduct: UniversalProductDTO = {
      ...product,
      classification: { ...product.classification, status: "partial", resolved: [] },
    };
    const result = resolveTargetAssignments(unresolvedModelProduct, [rule("collaboration", 100, [
      { field: "candidate.model.sourceValue", operator: "equals", values: ["Ronnie Fieg x Clarks x adidas 8th Street Samba"] },
      { field: "candidate.model.context.brand", operator: "equals", values: ["adidas"] },
    ], "715")]);

    expect(result).toEqual([{ ruleId: "collaboration", groupCode: "sandal_leaf", targetScope: "product.category", externalValue: "715", mode: "replace" }]);
  });

  it("matches a model phrase inside a title without matching a longer model word", () => {
    const tazzProduct: UniversalProductDTO = {
      ...product,
      referenceCandidates: product.referenceCandidates.map((candidate) => candidate.typeCode === "model"
        ? { ...candidate, sourceValue: "Palace x UGG Tazz 'Chestnut'" }
        : candidate),
    };
    const tazzetteProduct: UniversalProductDTO = {
      ...tazzProduct,
      referenceCandidates: tazzProduct.referenceCandidates.map((candidate) => candidate.typeCode === "model"
        ? { ...candidate, sourceValue: "UGG Tazzette 'Black'" }
        : candidate),
    };
    const phraseRule = rule("sabo", 100, [
      { field: "candidate.model.sourceValue", operator: "contains_phrase", values: ["UGG Tazz", "Birkenstock Tokio"] },
    ], "25922");

    expect(resolveTargetAssignments(tazzProduct, [phraseRule])).toHaveLength(1);
    expect(resolveTargetAssignments(tazzetteProduct, [phraseRule])).toEqual([]);
  });

  it("uses a source fact without creating a classifier candidate", () => {
    const result = resolveTargetAssignments(product, [rule("designer", 100, [
      { field: "product.fact.designer", operator: "equals", values: ["wilson smith"] },
    ], "715")]);

    expect(result).toEqual([{ ruleId: "designer", groupCode: "sandal_leaf", targetScope: "product.category", externalValue: "715", mode: "replace" }]);
    expect(product.referenceCandidates.some((candidate) => candidate.sourceValue === "Wilson Smith")).toBe(false);
  });
});
