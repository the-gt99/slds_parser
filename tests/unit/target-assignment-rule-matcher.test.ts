import { describe, expect, it } from "vitest";

import type { UniversalProductDTO } from "../../src/contracts/index.js";
import type { TargetAssignmentRuleRecord } from "../../src/repositories/index.js";
import { resolveTargetAssignments } from "../../src/services/index.js";

const product = {
  sourceProductId: "1", title: "Sandal model", description: "", sku: "SKU", images: [], variants: [], attributes: { gender: "women" }, metadata: {},
  sourceFacts: { designer: "Wilson Smith" },
  referenceCandidates: [
    { key: "category", typeCode: "category", scope: "product.category", subjectKind: "product", sourceValue: "sandals", context: { audience: "women", productCategory: "shoes" }, evidence: {} },
    { key: "marketing", typeCode: "merchandising_category", scope: "product.merchandising_category", subjectKind: "product", sourceValue: "Sandal", context: {}, evidence: {} },
    { key: "model", typeCode: "model", scope: "product.model", subjectKind: "product", sourceValue: "Ronnie Fieg x Clarks x adidas 8th Street Samba", context: { brand: "adidas", family: "Samba" }, evidence: {} },
  ],
  classification: { status: "complete", classifierVersion: "1", fingerprint: "x", ignored: [], unresolved: [], resolved: [
    { candidateKey: "model", typeCode: "model", scope: "product.model", subjectKind: "product", referenceValueId: "500", resolutionKind: "mapping", resolutionId: "10", resolutionRevision: "1" },
  ] },
} satisfies UniversalProductDTO;

function rule(id: string, priority: number, conditions: TargetAssignmentRuleRecord["conditions"], externalValue: string): TargetAssignmentRuleRecord {
  return { id, targetId: "10", name: id, groupCode: "sandal_leaf", priority, conditionGroups: conditions.map((condition) => ({ conditions: [condition] })), conditions, actions: [{ targetScope: "product.category", dictionaryValueId: externalValue, externalValue, externalLabel: externalValue, mode: "replace" }], enabled: true, revision: "1", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
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

    expect(result).toEqual([{ ruleId: "special", groupCode: "sandal_leaf", targetScope: "product.category", externalValue: "900", externalLabel: "900", mode: "replace" }]);
  });

  it("rejects equally prioritized matches in one exclusive group", () => {
    const conditions = [{ field: "candidate.category.sourceValue", operator: "equals" as const, values: ["sandals"] }];
    expect(() => resolveTargetAssignments(product, [rule("a", 100, conditions, "1"), rule("b", 100, conditions, "2")]))
      .toThrow("equally prioritized matching rules: a (#a), b (#b)");
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

    expect(result).toEqual([{ ruleId: "collaboration", groupCode: "sandal_leaf", targetScope: "product.category", externalValue: "715", externalLabel: "715", mode: "replace" }]);
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

  it("ignores source audience markers in model phrases", () => {
    const wmnsProduct: UniversalProductDTO = {
      ...product,
      referenceCandidates: product.referenceCandidates.map((candidate) => candidate.typeCode === "model"
        ? { ...candidate, sourceValue: "UGG Wmns Goldenstar Clog 'Chestnut'" }
        : candidate),
    };
    expect(resolveTargetAssignments(wmnsProduct, [rule("sabo", 100, [
      { field: "candidate.model.sourceValue", operator: "contains_phrase", values: ["UGG Goldenstar Clog"] },
    ], "25923")])).toHaveLength(1);
  });

  it("uses a source fact without creating a classifier candidate", () => {
    const result = resolveTargetAssignments(product, [rule("designer", 100, [
      { field: "product.fact.designer", operator: "equals", values: ["wilson smith"] },
    ], "715")]);

    expect(result).toEqual([{ ruleId: "designer", groupCode: "sandal_leaf", targetScope: "product.category", externalValue: "715", externalLabel: "715", mode: "replace" }]);
    expect(product.referenceCandidates.some((candidate) => candidate.sourceValue === "Wilson Smith")).toBe(false);
  });

  it("reads nested common DTO fields and scalar arrays", () => {
    const nestedProduct: UniversalProductDTO = {
      ...product,
      attributes: { ...product.attributes, taxonomy: { taxonomyLevel4: "Shirts and Tops" }, ageGroups: ["adult", "teen"] },
    };
    expect(resolveTargetAssignments(nestedProduct, [rule("taxonomy", 100, [
      { field: "product.attribute.taxonomy.taxonomyLevel4", operator: "equals", values: ["shirts and tops"] },
      { field: "product.attribute.ageGroups", operator: "one_of", values: ["teen"] },
    ], "715")])).toHaveLength(1);
  });

  it("matches a safe regular expression against the product title or description", () => {
    const runningProduct: UniversalProductDTO = {
      ...product,
      title: "Nike ZoomX Running Shoe",
      description: "Подходит для марафона",
    };
    const textRule = {
      ...rule("running", 100, [], "25614"),
      conditionGroups: [{ conditions: [
        { field: "product.title", operator: "regex" as const, values: ["\\b(running|jogging)\\b"] },
        { field: "product.description", operator: "regex" as const, values: ["\\bмарафон\\w*\\b"] },
      ] }],
    };

    expect(resolveTargetAssignments(runningProduct, [textRule])).toHaveLength(1);
    expect(resolveTargetAssignments({ ...runningProduct, title: "Nike Lifestyle", description: "" }, [textRule])).toEqual([]);
  });

  it("rejects unsafe or invalid assignment regular expressions", () => {
    const invalid = rule("invalid", 100, [
      { field: "product.title", operator: "regex", values: ["(running+)+$"] },
    ], "25614");

    expect(() => resolveTargetAssignments(product, [invalid])).toThrow("nested unbounded quantifiers");
  });

  it("matches absent resolved values only when classification has no such type", () => {
    const absentActivity = rule("no-activity", 100, [
      { field: "resolved.activity", operator: "absent", values: [] },
    ], "25614");

    expect(resolveTargetAssignments(product, [absentActivity])).toHaveLength(1);
    expect(resolveTargetAssignments({
      ...product,
      classification: { ...product.classification, resolved: [{ ...product.classification.resolved[0]!, typeCode: "activity", referenceValueId: "122" }] },
    }, [absentActivity])).toEqual([]);
  });

  it("supports OR inside a group and AND between groups", () => {
    const conditions = [
      { field: "candidate.model.sourceValue", operator: "contains_phrase" as const, values: ["missing"] },
      { field: "candidate.category.sourceValue", operator: "one_of" as const, values: ["sandals", "sandal"] },
      { field: "candidate.category.context.audience", operator: "equals" as const, values: ["women"] },
    ];
    const item = { ...rule("or-groups", 100, conditions, "75"), conditionGroups: [{ conditions: conditions.slice(0, 2) }, { conditions: [conditions[2]!] }] };

    expect(resolveTargetAssignments(product, [item])).toHaveLength(1);
  });

  it("does not treat a sneaker model named Slide as slippers", () => {
    const slipperRule = {
      ...rule("slippers", 230, [], "25865"),
      conditionGroups: [
        { conditions: [{ field: "candidate.category.context.productCategory", operator: "equals" as const, values: ["shoes"] }] },
        { conditions: [
          { field: "product.title", operator: "contains_phrase" as const, values: ["slipper", "slippers", "mule", "mules"] },
          { field: "product.title", operator: "regex" as const, values: ["\\bslides?\\b(\\s+sandal\\b|\\s*'|$)"] },
        ] },
      ],
    };

    expect(resolveTargetAssignments({ ...product, title: "Golden Goose Wmns Slide Sneaker 'White'" }, [slipperRule])).toEqual([]);
    expect(resolveTargetAssignments({ ...product, title: "UGG Wmns Pumped Slide 'Chestnut'" }, [slipperRule])).toHaveLength(1);
    expect(resolveTargetAssignments({ ...product, title: "Balenciaga Slide Sandal 'Navy'" }, [slipperRule])).toHaveLength(1);
  });
});
