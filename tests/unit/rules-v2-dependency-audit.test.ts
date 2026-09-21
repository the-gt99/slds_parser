import { describe, expect, it } from "vitest";
import type { RuleV2Record } from "../../src/repositories/index.js";
import { auditRulesV2Dependencies } from "../../src/services/rules-v2-dependency-audit.js";

function rule(overrides: Partial<RuleV2Record>): RuleV2Record {
  return { id: "1", sourceId: null, sourceCode: null, targetId: "2", targetCode: "shop", name: "Rule",
    groupCode: "model", priority: 100, status: "shadow", conditionGroups: [], actions: [],
    originKind: "target_mapping", originId: "1", originRevision: "1", originPayload: {}, revision: "1",
    createdAt: "2026-09-20", updatedAt: "2026-09-20", ...overrides };
}
function mapping(id: string, referenceId: string, term: string): RuleV2Record {
  return rule({ id, originId: id, originPayload: { referenceValueId: referenceId }, actions: [{ targetScope: "product.model",
    dictionaryValueId: term, externalValue: term, externalLabel: term, mode: "replace" }] });
}

describe("rules v2 resolved dependency audit", () => {
  it("detects a target-term collision that makes a direct rewrite unsafe", () => {
    const assignment = rule({ id: "3", originKind: "target_assignment_rule", conditionGroups: [{ conditions: [
      { field: "resolved.model", operator: "one_of", values: ["10"] },
    ] }] });
    expect(auditRulesV2Dependencies([mapping("1", "10", "50"), mapping("2", "11", "50"), assignment]))
      .toEqual([{ ruleId: "3", field: "resolved.model", operator: "one_of", references: 1,
        mappedTerms: 1, missingMappings: 0, collidingTerms: 1 }]);
  });
  it("reports absent conditions separately from value lists", () => {
    const assignment = rule({ id: "3", originKind: "target_assignment_rule", conditionGroups: [{ conditions: [
      { field: "resolved.activity", operator: "absent", values: [] },
    ] }] });
    expect(auditRulesV2Dependencies([assignment])[0]).toMatchObject({ references: 0, mappedTerms: 0,
      missingMappings: 0, collidingTerms: 0, operator: "absent" });
  });
});
