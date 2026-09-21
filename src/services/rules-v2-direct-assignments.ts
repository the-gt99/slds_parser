import type { TargetAssignmentDTO, UniversalProductDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { RuleV2Record, TargetAssignmentRuleRecord } from "../repositories/index.js";
import { auditRulesV2Dependencies } from "./rules-v2-dependency-audit.js";
import { buildDirectTargetRulePlans } from "./rules-v2-direct-plan.js";
import { DirectRulesV2Selector } from "./rules-v2-direct-selector.js";
import { rulesV2FieldReader, type RulesV2ProductSource } from "./rules-v2-snapshot.js";
import { resolveTargetAssignments } from "./target-assignment-rule-matcher.js";

const key = (...parts: readonly string[]) => JSON.stringify(parts);

/** Compiles dependent assignments to WordPress terms, without reading internal reference tables. */
export class DirectRulesV2Assignments {
  private readonly selector: DirectRulesV2Selector;
  private readonly plansBySource = new Map<string, ReturnType<typeof buildDirectTargetRulePlans>[number][]>();
  private readonly assignments: readonly TargetAssignmentRuleRecord[];

  constructor(records: readonly RuleV2Record[], private readonly targetId: string) {
    const unsafe = auditRulesV2Dependencies(records).filter((row) => row.missingMappings > 0 || row.collidingTerms > 0);
    if (unsafe.length > 0) throw new IntegrationContractError(`Cannot translate ${unsafe.length} resolved-value conditions to target terms`);
    this.selector = new DirectRulesV2Selector(records);
    const mappings = new Map<string, Set<string>>();
    for (const rule of records) {
      if (rule.status !== "shadow" || rule.targetId !== targetId || rule.originKind !== "target_mapping") continue;
      const referenceId = rule.originPayload.referenceValueId;
      if (typeof referenceId !== "string") continue;
      for (const action of rule.actions) {
        if (action.kind === "resolve_reference") continue;
        const lookup = key(action.targetScope, referenceId);
        const terms = mappings.get(lookup) ?? new Set<string>();
        terms.add(action.externalValue);
        mappings.set(lookup, terms);
      }
    }
    for (const plan of buildDirectTargetRulePlans(records)) {
      if (plan.targetId !== targetId) continue;
      const entries = this.plansBySource.get(plan.sourceRuleId) ?? [];
      entries.push(plan);
      this.plansBySource.set(plan.sourceRuleId, entries);
    }
    this.assignments = records.flatMap((rule): TargetAssignmentRuleRecord[] => {
      if (rule.status !== "shadow" || rule.targetId !== targetId
        || (rule.originKind !== "target_assignment_rule" && rule.originKind !== "native")) return [];
      if (rule.actions.some((action) => action.kind === "resolve_reference")) throw new IntegrationContractError(`Invalid assignment ${rule.id}`);
      const conditionGroups = rule.conditionGroups.map((group) => ({ ...group, conditions: group.conditions.map((condition) => {
        if (!condition.field.startsWith("resolved.")) return condition;
        const scope = `product.${condition.field.slice("resolved.".length)}`;
        const terms = new Set<string>();
        for (const referenceId of condition.values) {
          const mapped = mappings.get(key(scope, referenceId));
          if (mapped === undefined) throw new IntegrationContractError(`Missing target mapping for ${scope}/${referenceId}`);
          for (const value of mapped) terms.add(value);
        }
        return { ...condition, field: `assigned.${condition.field.slice("resolved.".length)}`,
          values: [...terms] };
      }) }));
      this.assignmentsById.set(rule.originId ?? rule.id, rule);
      return [{ id: rule.originId ?? rule.id, targetId, name: rule.name, groupCode: rule.groupCode,
        priority: rule.priority, conditionGroups, conditions: conditionGroups.flatMap((group) => group.conditions),
        actions: rule.actions.flatMap((action) => action.kind === "resolve_reference" ? [] : [action]),
        enabled: true, revision: rule.revision,
        createdAt: rule.createdAt, updatedAt: rule.updatedAt }];
    });
  }

  resolve(product: UniversalProductDTO, source: RulesV2ProductSource): readonly TargetAssignmentDTO[] {
    const selected = this.selector.select(source, product);
    const assigned = new Map<string, Set<string>>();
    for (const selection of selected) {
      if (selection.status !== "resolved" || selection.sourceRuleId === null) continue;
      for (const plan of this.plansBySource.get(selection.sourceRuleId) ?? []) {
        for (const action of plan.actions) {
          if (action.originKind !== "target_mapping") continue;
          const field = `assigned.${plan.referenceType}`;
          const terms = assigned.get(field) ?? new Set<string>();
          terms.add(action.externalValue);
          assigned.set(field, terms);
        }
      }
    }
    const read = rulesV2FieldReader(product, source);
    return resolveTargetAssignments(product, this.assignments.filter((rule) => {
      const original = this.assignmentsById.get(rule.id);
      return original?.sourceId === null || original?.sourceId === source.id;
    }), (field) => field.startsWith("assigned.") ? [...(assigned.get(field) ?? [])] : read(field));
  }

  private readonly assignmentsById = new Map<string, RuleV2Record>();
}
