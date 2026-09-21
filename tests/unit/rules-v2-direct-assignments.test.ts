import { describe, expect, it } from "vitest";
import type { UniversalProductDTO } from "../../src/contracts/index.js";
import type { RuleV2Record } from "../../src/repositories/index.js";
import { DirectRulesV2Assignments } from "../../src/services/rules-v2-direct-assignments.js";

const source = { id: "1", code: "goat", productId: "5", sourceKey: "abc", externalId: null };
const product: UniversalProductDTO = { sourceProductId: "5", title: "Adidas Samba", description: "", sku: "S",
  images: [], variants: [], attributes: {}, metadata: {}, referenceCandidates: [{ key: "product:model", typeCode: "model",
    scope: "product.model", subjectKind: "product", sourceValue: "Samba", context: {}, evidence: {} }] };
function rule(overrides: Partial<RuleV2Record>): RuleV2Record {
  return { id: "1", sourceId: "1", sourceCode: "goat", targetId: null, targetCode: null, name: "Rule",
    groupCode: "classification_exact", priority: 1_000_000, status: "shadow", conditionGroups: [{ conditions: [
      { field: "candidate.model.sourceValue", operator: "equals", values: ["Samba"] },
    ] }], actions: [{ kind: "resolve_reference", referenceType: "model", referenceValueId: "10",
      referenceValueCode: "samba", referenceValueName: "Samba", resolutionStatus: "confirmed" }],
    originKind: "exact_mapping", originId: "20", originRevision: "1", originPayload: {
      scope: "product.model", normalizedSourceValue: "samba", contextKey: "{}",
    }, revision: "1", createdAt: "2026-09-20", updatedAt: "2026-09-20", ...overrides };
}

describe("direct dependent assignments", () => {
  it("matches the WordPress model term rather than an internal reference ID", () => {
    const mapping = rule({ id: "2", sourceId: null, targetId: "5", originKind: "target_mapping", originId: "21",
      originPayload: { referenceValueId: "10" }, actions: [{ targetScope: "product.model", dictionaryValueId: "50",
        externalValue: "50", externalLabel: "Samba", mode: "replace" }] });
    const assignment = rule({ id: "3", sourceId: null, targetId: "5", originKind: "target_assignment_rule", originId: "22",
      groupCode: "extra_brand", priority: 100, conditionGroups: [{ conditions: [
        { field: "resolved.model", operator: "one_of", values: ["10"] },
      ] }], actions: [{ targetScope: "product.brand", dictionaryValueId: "70", externalValue: "70",
        externalLabel: "Extra brand", mode: "add" }] });
    const engine = new DirectRulesV2Assignments([rule({}), mapping, assignment], "5");
    expect(engine.resolveTerms(product, source)).toMatchObject({ selections: [{ status: "resolved", sourceRuleId: "1" }],
      terms: [{ candidateKey: "product:model", referenceType: "model", originKind: "target_mapping",
        externalValue: "50" }] });
    expect(engine.resolve(product, source)).toMatchObject([{ ruleId: "22", targetScope: "product.brand",
      externalValue: "70" }]);
    expect(engine.matchesRule("22", product, source)).toBe(true);
    expect(engine.matchesRule("22", { ...product, referenceCandidates: [] }, source)).toBe(false);
    expect(engine.resolve({ ...product, referenceCandidates: [] }, source)).toEqual([]);
  });
});
