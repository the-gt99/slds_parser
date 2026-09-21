import type { RuleV2Record } from "../repositories/index.js";

export interface RulesV2DependencyAuditRow {
  readonly ruleId: string;
  readonly field: string;
  readonly operator: string;
  readonly references: number;
  readonly mappedTerms: number;
  readonly missingMappings: number;
  readonly collidingTerms: number;
}

/** Checks whether legacy resolved-value conditions can be rewritten as target-term conditions. */
export function auditRulesV2Dependencies(records: readonly RuleV2Record[]): readonly RulesV2DependencyAuditRow[] {
  const byReference = new Map<string, Set<string>>();
  const byTerm = new Map<string, Set<string>>();
  const key = (...parts: readonly string[]) => JSON.stringify(parts);
  for (const rule of records) {
    if (rule.status !== "shadow" || rule.originKind !== "target_mapping" || rule.targetId === null) continue;
    const referenceId = rule.originPayload.referenceValueId;
    if (typeof referenceId !== "string") continue;
    for (const action of rule.actions) {
      if (action.kind === "resolve_reference") continue;
      const referenceKey = key(rule.targetId, action.targetScope, referenceId);
      const termKey = key(rule.targetId, action.targetScope, action.externalValue);
      const terms = byReference.get(referenceKey) ?? new Set<string>();
      terms.add(action.externalValue);
      byReference.set(referenceKey, terms);
      const references = byTerm.get(termKey) ?? new Set<string>();
      references.add(referenceId);
      byTerm.set(termKey, references);
    }
  }
  const report: RulesV2DependencyAuditRow[] = [];
  for (const rule of records) {
    if (rule.status !== "shadow" || rule.targetId === null
      || (rule.originKind !== "target_assignment_rule" && rule.originKind !== "native")) continue;
    for (const group of rule.conditionGroups) for (const condition of group.conditions) {
      if (!condition.field.startsWith("resolved.")) continue;
      const scope = `product.${condition.field.slice("resolved.".length)}`;
      const references = new Set(condition.values);
      const terms = new Set<string>();
      let missingMappings = 0;
      for (const referenceId of references) {
        const mapped = byReference.get(key(rule.targetId, scope, referenceId));
        if (mapped === undefined) missingMappings++;
        else for (const value of mapped) terms.add(value);
      }
      const collidingTerms = [...terms].filter((term) => [...(byTerm.get(key(rule.targetId!, scope, term)) ?? [])]
        .some((referenceId) => !references.has(referenceId))).length;
      report.push({ ruleId: rule.id, field: condition.field, operator: condition.operator,
        references: references.size, mappedTerms: terms.size, missingMappings, collidingTerms });
    }
  }
  return report;
}
