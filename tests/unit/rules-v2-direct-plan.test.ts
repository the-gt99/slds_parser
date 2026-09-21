import { describe, expect, it } from "vitest";
import type { RuleV2Record } from "../../src/repositories/index.js";
import { buildDirectTargetRulePlans } from "../../src/services/rules-v2-direct-plan.js";

function record(overrides: Partial<RuleV2Record>): RuleV2Record {
  return { id: "1", sourceId: "1", sourceCode: "goat", targetId: null, targetCode: null,
    name: "Rule", groupCode: "classification_exact", priority: 1_000_000, status: "shadow",
    conditionGroups: [{ conditions: [{ field: "candidate.brand.sourceValue", operator: "equals", values: ["Adidas"] }] }],
    actions: [{ kind: "resolve_reference", referenceType: "brand", referenceValueId: "10",
      referenceValueCode: "adidas", referenceValueName: "Adidas", resolutionStatus: "confirmed" }],
    originKind: "exact_mapping", originId: "20", originRevision: "1", originPayload: {}, revision: "1",
    createdAt: "2026-09-20", updatedAt: "2026-09-20", ...overrides };
}

const assignment = { kind: "assign_target_term" as const, targetScope: "product.brand", dictionaryValueId: "30",
  externalValue: "40", externalLabel: "Adidas", mode: "replace" as const };

describe("direct target rule plans", () => {
  it("joins only active source decisions to their matching target bindings", () => {
    const source = record({});
    const mapping = record({ id: "2", sourceId: null, targetId: "5", originKind: "target_mapping", originId: "21",
      originPayload: { referenceValueId: "10" }, actions: [assignment] });
    const projection = record({ id: "3", sourceId: null, targetId: "5", originKind: "reference_projection", originId: "22",
      originPayload: { referenceValueId: "10", externalSlug: "adidas", metadata: { relationCode: "landing" } },
      actions: [{ ...assignment, targetScope: "product.tag", dictionaryValueId: "31", mode: "add" }] });
    const other = record({ id: "4", sourceId: null, targetId: "5", originKind: "reference_projection", originId: "23",
      originPayload: { referenceValueId: "11" }, actions: [assignment] });
    const result = buildDirectTargetRulePlans([source, mapping, projection, other]);
    expect(result).toHaveLength(1);
    expect(result[0]?.conditions[0]?.conditions[0]?.field).toBe("candidate.brand.sourceValue");
    expect(result[0]?.actions.map((action) => [action.originKind, action.originId, action.targetScope])).toEqual([
      ["target_mapping", "21", "product.brand"], ["reference_projection", "22", "product.tag"],
    ]);
    expect(result[0]?.actions[1]?.externalSlug).toBe("adidas");
  });

  it("keeps a classification-specific projection attached only to its source decision", () => {
    const projection = record({ id: "3", sourceId: "1", targetId: "5", originKind: "classification_projection", originId: "22",
      originPayload: { sourceOrigin: { mappingId: "20", ruleId: null } }, actions: [assignment] });
    expect(buildDirectTargetRulePlans([record({}), projection])).toHaveLength(1);
    expect(buildDirectTargetRulePlans([record({ originId: "21" }), projection])).toHaveLength(0);
  });

  it("does not assign terms for ignored, disabled or unresolved source decisions", () => {
    const mapping = record({ id: "2", sourceId: null, targetId: "5", originKind: "target_mapping", originId: "21",
      originPayload: { referenceValueId: "10" }, actions: [assignment] });
    const ignored = record({ actions: [{ kind: "resolve_reference", referenceType: "brand", referenceValueId: "10",
      referenceValueCode: "adidas", referenceValueName: "Adidas", resolutionStatus: "ignored" }] });
    expect(buildDirectTargetRulePlans([ignored, mapping])).toEqual([]);
    expect(buildDirectTargetRulePlans([record({ status: "disabled" }), mapping])).toEqual([]);
    expect(buildDirectTargetRulePlans([record({ actions: [{ kind: "resolve_reference", referenceType: "brand",
      referenceValueId: null, referenceValueCode: null, referenceValueName: null, resolutionStatus: "confirmed" }] }), mapping])).toEqual([]);
  });
});
