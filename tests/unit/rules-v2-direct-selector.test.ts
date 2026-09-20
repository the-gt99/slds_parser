import { describe, expect, it } from "vitest";
import type { UniversalProductDTO } from "../../src/contracts/index.js";
import type { RuleV2Record } from "../../src/repositories/index.js";
import { DirectRulesV2Selector } from "../../src/services/rules-v2-direct-selector.js";

const source = { id: "1", code: "goat", productId: "5", sourceKey: "abc", externalId: null };
const product: UniversalProductDTO = { sourceProductId: "5", title: "Adidas Samba", description: "", sku: "S",
  images: [], variants: [], attributes: { family: "Samba" }, metadata: {}, referenceCandidates: [
    { key: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product",
      sourceValue: "Samba", context: { brand: "Adidas", family: "Samba" }, evidence: {} },
  ] };
function rule(overrides: Partial<RuleV2Record>): RuleV2Record {
  return { id: "1", sourceId: "1", sourceCode: "goat", targetId: null, targetCode: null, name: "Rule",
    groupCode: "classification_rule", priority: 100, status: "shadow", conditionGroups: [{ conditions: [
      { field: "candidate.model.context.family", operator: "equals", values: ["Samba"] },
    ] }], actions: [{ kind: "resolve_reference", referenceType: "model", referenceValueId: "10",
      referenceValueCode: "samba", referenceValueName: "Samba", resolutionStatus: "confirmed" }],
    originKind: "classification_rule", originId: "20", originRevision: "1", originPayload: {}, revision: "1",
    createdAt: "2026-09-20", updatedAt: "2026-09-20", ...overrides };
}

describe("direct source rule selection", () => {
  it("chooses a full-context exact rule before a broad conditional rule", () => {
    const exact = rule({ id: "2", originKind: "exact_mapping", originId: "21", originPayload: {
      scope: "product.model", normalizedSourceValue: "samba", contextKey: '{"brand":"Adidas","family":"Samba"}',
    } });
    expect(new DirectRulesV2Selector([rule({}), exact]).select(source, product)).toEqual([
      { candidateKey: "product:model", status: "resolved", sourceRuleId: "2" },
    ]);
    expect(new DirectRulesV2Selector([rule({}), { ...exact, originPayload: { ...exact.originPayload,
      contextKey: '{"brand":"Nike","family":"Samba"}' } }]).select(source, product)[0]?.sourceRuleId).toBe("1");
  });

  it("uses priority and marks equal-priority conflicting values ambiguous", () => {
    const higher = rule({ id: "2", originId: "21", priority: 200 });
    expect(new DirectRulesV2Selector([rule({}), higher]).select(source, product)[0]?.sourceRuleId).toBe("2");
    const conflicting = rule({ id: "3", originId: "22", actions: [{ kind: "resolve_reference", referenceType: "model",
      referenceValueId: "11", referenceValueCode: "other", referenceValueName: "Other", resolutionStatus: "confirmed" }] });
    expect(new DirectRulesV2Selector([rule({}), conflicting]).select(source, product)[0]?.status).toBe("ambiguous");
  });

  it("never matches a rule when its source candidate is absent", () => {
    expect(new DirectRulesV2Selector([rule({})]).select(source, { ...product, referenceCandidates: [] })).toEqual([]);
  });
});
