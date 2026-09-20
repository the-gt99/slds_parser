import type { RuleV2Action, RuleV2Record } from "../repositories/index.js";
import { directRulesV2Conditions } from "./rules-v2-direct-fields.js";

export interface DirectTargetRulePlan {
  readonly sourceRuleId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly referenceType: string;
  readonly conditions: RuleV2Record["conditionGroups"];
  readonly actions: readonly {
    readonly originKind: "target_mapping" | "reference_projection" | "classification_projection";
    readonly originId: string;
    readonly targetScope: string;
    readonly dictionaryValueId: string;
    readonly externalValue: string;
    readonly externalLabel: string;
    readonly externalSlug: string | null;
    readonly metadata: Readonly<Record<string, unknown>>;
  }[];
}

/** Materializes source selectors and WordPress terms without querying old reference tables. */
export function buildDirectTargetRulePlans(records: readonly RuleV2Record[]): readonly DirectTargetRulePlan[] {
  type Binding = { readonly rule: RuleV2Record; readonly action: RuleV2Action };
  const byReference = new Map<string, Binding[]>();
  const byResolution = new Map<string, Binding[]>();
  const append = (map: Map<string, Binding[]>, key: string, binding: Binding) => map.set(key, [...(map.get(key) ?? []), binding]);
  for (const rule of records) {
    if (rule.status !== "shadow") continue;
    if (rule.originKind !== "target_mapping" && rule.originKind !== "reference_projection"
      && rule.originKind !== "classification_projection") continue;
    for (const action of rule.actions) {
      if (action.kind === "resolve_reference") continue;
      const binding = { rule, action };
      if (rule.originKind === "classification_projection") {
        const source = rule.originPayload.sourceOrigin;
        if (source === null || typeof source !== "object") continue;
        const origin = source as { readonly mappingId?: unknown; readonly ruleId?: unknown };
        const key = origin.mappingId === null || origin.mappingId === undefined
          ? `classification_rule:${String(origin.ruleId)}` : `exact_mapping:${String(origin.mappingId)}`;
        append(byResolution, key, binding);
      } else {
        const referenceId = rule.originPayload.referenceValueId;
        if (typeof referenceId === "string") append(byReference, referenceId, binding);
      }
    }
  }
  const plans: DirectTargetRulePlan[] = [];
  for (const rule of records) {
    if (rule.status !== "shadow" || (rule.originKind !== "exact_mapping" && rule.originKind !== "classification_rule")
      || rule.sourceId === null) continue;
    const reference = rule.actions.find((action) => action.kind === "resolve_reference");
    if (reference?.kind !== "resolve_reference" || reference.resolutionStatus === "ignored" || reference.referenceValueId === null) continue;
    const conditions = directRulesV2Conditions(rule);
    if (conditions === null) continue;
    const bindings = [...(byReference.get(reference.referenceValueId) ?? []),
      ...(byResolution.get(`${rule.originKind}:${rule.originId ?? rule.id}`) ?? [])];
    const byTarget = new Map<string, Binding[]>();
    for (const binding of bindings) {
      const targetId = binding.rule.targetId;
      if (targetId === null) continue;
      byTarget.set(targetId, [...(byTarget.get(targetId) ?? []), binding]);
    }
    for (const [targetId, targetBindings] of byTarget) {
      const actions = [...new Map(targetBindings.map(({ rule: binding, action }) => {
        const originId = binding.originId ?? binding.id;
        const key = `${binding.originKind}:${originId}:${action.targetScope}:${action.dictionaryValueId}`;
        return [key, { originKind: binding.originKind as DirectTargetRulePlan["actions"][number]["originKind"], originId,
          targetScope: action.targetScope, dictionaryValueId: action.dictionaryValueId,
          externalValue: action.externalValue, externalLabel: action.externalLabel,
          externalSlug: typeof binding.originPayload.externalSlug === "string" ? binding.originPayload.externalSlug : null,
          metadata: (binding.originPayload.metadata ?? {}) as Readonly<Record<string, unknown>> }];
      })).values()];
      plans.push({ sourceRuleId: rule.id, sourceId: rule.sourceId, targetId, referenceType: reference.referenceType,
        conditions, actions });
    }
  }
  return plans;
}
