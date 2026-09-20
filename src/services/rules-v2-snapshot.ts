import type { JsonObject, UniversalProductDTO } from "../contracts/index.js";
import { toCommonProductDTO } from "../contracts/common-product.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { ClassificationLookupInput, ClassificationMappingMatchRecord, ClassificationReferenceTypeRecord, ClassificationRuleRecord,
  RuleV2Record, RuleV2Action, TargetAssignmentRuleRecord, TargetValueMappingRecord,
  TargetClassificationProjectionRecord, TargetReferenceProjectionRecord } from "../repositories/index.js";
import { resolveTargetAssignments, targetAssignmentFieldValues } from "./target-assignment-rule-matcher.js";
import { validateRulesV2Field } from "./rules-v2-fields.js";

const key = (...parts: readonly unknown[]) => JSON.stringify(parts);
const normalize = (value: string) => value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
const numericOrder = (a: { id: string }, b: { id: string }) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;

export interface RulesV2ProductSource {
  readonly id: string;
  readonly code: string;
  readonly productId: string;
  readonly sourceKey: string;
  readonly externalId: string | null;
}

function valuesAt(value: unknown, path: readonly string[]): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => valuesAt(item, path[0] === "*" ? path.slice(1) : path));
  if (path.length === 0) return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [String(value)] : [];
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, path[0]!)) return [];
  return valuesAt((value as Record<string, unknown>)[path[0]!], path.slice(1));
}

export function rulesV2FieldReader(product: UniversalProductDTO, source: RulesV2ProductSource) {
  const common = toCommonProductDTO(product, source, { id: source.productId, sourceKey: source.sourceKey, externalId: source.externalId });
  const cache = new Map<string, readonly string[]>();
  return (field: string): readonly string[] => {
    const cached = cache.get(field);
    if (cached !== undefined) return cached;
    validateRulesV2Field(field);
    const result = field.startsWith("common.") ? valuesAt(common, field.slice(7).split("."))
      : targetAssignmentFieldValues(product, field);
    cache.set(field, result);
    return result;
  };
}

/** Index only a necessary AND group: indexing one branch of an OR would lose valid matches. */
class AssignmentIndex {
  private readonly exact = new Map<string, Map<string, Set<TargetAssignmentRuleRecord>>>();
  private readonly general: TargetAssignmentRuleRecord[] = [];
  constructor(rules: readonly TargetAssignmentRuleRecord[]) {
    for (const rule of rules) {
      const group = rule.conditionGroups.find((item) => item.conditions.length > 0 && item.conditions.every(
        (condition) => (condition.operator === "equals" || condition.operator === "one_of") && condition.values.length > 0));
      if (group === undefined) { this.general.push(rule); continue; }
      for (const condition of group.conditions) {
        const field = this.exact.get(condition.field) ?? new Map<string, Set<TargetAssignmentRuleRecord>>();
        for (const value of condition.values) {
          const matching = field.get(normalize(value)) ?? new Set<TargetAssignmentRuleRecord>();
          matching.add(rule);
          field.set(normalize(value), matching);
        }
        this.exact.set(condition.field, field);
      }
    }
  }
  select(read: (field: string) => readonly string[]): readonly TargetAssignmentRuleRecord[] {
    const selected = new Set(this.general);
    for (const [field, index] of this.exact) for (const value of read(field)) {
      for (const rule of index.get(normalize(value)) ?? []) selected.add(rule);
    }
    return [...selected].sort((a, b) => a.groupCode.localeCompare(b.groupCode) || b.priority - a.priority || numericOrder(a, b));
  }
}

/** Compiled migration semantics. No lookup of legacy mappings/rules during evaluation. */
export class RulesV2Snapshot {
  private readonly exact = new Map<string, Omit<ClassificationMappingMatchRecord, "candidateKey">>();
  private readonly classification = new Map<string, ClassificationRuleRecord[]>();
  private readonly mappings = new Map<string, TargetValueMappingRecord>();
  private readonly specific = new Map<string, TargetClassificationProjectionRecord[]>();
  private readonly canonical = new Map<string, TargetReferenceProjectionRecord[]>();
  private readonly assignments = new Map<string, TargetAssignmentRuleRecord[]>();
  private readonly native = new Map<string, AssignmentIndex>();

  constructor(readonly revision: string, readonly records: readonly RuleV2Record[],
    private readonly referenceTypes: readonly ClassificationReferenceTypeRecord[] = []) {
    const native = new Map<string, TargetAssignmentRuleRecord[]>();
    for (const rule of records) {
      if (rule.status !== "shadow") continue;
      const originId = rule.originId ?? rule.id;
      const payload = rule.originPayload;
      const reference = rule.actions.find((action) => action.kind === "resolve_reference");
      if (reference?.kind === "resolve_reference") {
        if (rule.sourceId === null) throw new IntegrationContractError(`Rule ${rule.id} requires source`);
        if (rule.originKind === "exact_mapping") {
          const lookup = key(rule.sourceId, reference.referenceType, payload.scope, payload.normalizedSourceValue, payload.contextKey);
          if (this.exact.has(lookup)) throw new IntegrationContractError(`Duplicate exact v2 decision: ${rule.id}`);
          this.exact.set(lookup, { mappingId: originId, referenceValueId: reference.referenceValueId,
            status: reference.resolutionStatus, revision: rule.originRevision });
        } else if (rule.originKind === "classification_rule") {
          if (reference.referenceValueId === null || !Array.isArray(payload.conditions)) throw new IntegrationContractError(`Invalid migrated rule ${rule.id}`);
          const rules = this.classification.get(rule.sourceId) ?? [];
          rules.push({ id: originId, sourceId: rule.sourceId, typeCode: reference.referenceType, name: rule.name,
            priority: rule.priority, conditions: payload.conditions as ClassificationRuleRecord["conditions"],
            referenceValueId: reference.referenceValueId, revision: rule.originRevision });
          this.classification.set(rule.sourceId, rules);
        } else throw new IntegrationContractError(`Unsupported reference action in rule ${rule.id}`);
        continue;
      }
      if (rule.targetId === null) throw new IntegrationContractError(`Rule ${rule.id} requires target`);
      const actions = rule.actions as readonly RuleV2Action[];
      if (rule.originKind === "target_mapping") {
        for (const action of actions) this.mappings.set(key(rule.targetId, payload.referenceValueId, action.targetScope), {
          id: originId, targetId: rule.targetId, referenceValueId: String(payload.referenceValueId), targetScope: action.targetScope,
          externalValue: action.externalValue, externalLabel: action.externalLabel, metadata: (payload.metadata ?? {}) as JsonObject,
        });
      } else if (rule.originKind === "classification_projection" || rule.originKind === "reference_projection") {
        for (const action of actions) {
          const projection = { id: originId, targetId: rule.targetId, targetScope: action.targetScope,
            dictionaryValueId: action.dictionaryValueId, externalValue: action.externalValue, externalLabel: action.externalLabel,
            externalSlug: typeof payload.externalSlug === "string" ? payload.externalSlug : null,
            metadata: (payload.metadata ?? {}) as JsonObject, revision: rule.originRevision };
          if (rule.originKind === "reference_projection") {
            const referenceValueId = String(payload.referenceValueId);
            const lookup = key(rule.targetId, referenceValueId);
            this.canonical.set(lookup, [...(this.canonical.get(lookup) ?? []), { ...projection, referenceValueId }]);
          } else {
            const origin = payload.sourceOrigin as { mappingId: string | null; ruleId: string | null };
            const resolutionKind = origin.mappingId !== null ? "mapping" : "rule";
            const resolutionId = origin.mappingId ?? origin.ruleId;
            if (resolutionId === null) throw new IntegrationContractError(`Projection ${rule.id} has no resolution`);
            const lookup = key(rule.targetId, resolutionKind, resolutionId);
            this.specific.set(lookup, [...(this.specific.get(lookup) ?? []), { ...projection, resolutionKind, resolutionId }]);
          }
        }
      } else if (rule.originKind === "target_assignment_rule" || rule.originKind === "native") {
        const assignment: TargetAssignmentRuleRecord = { id: originId, targetId: rule.targetId, name: rule.name,
          groupCode: rule.groupCode, priority: rule.priority, conditionGroups: rule.conditionGroups,
          conditions: rule.conditionGroups.flatMap((group) => group.conditions), actions, enabled: true,
          revision: rule.revision, createdAt: rule.createdAt, updatedAt: rule.updatedAt };
        const store = rule.originKind === "native" ? native : this.assignments;
        const lookup = rule.originKind === "native" ? key(rule.targetId, rule.sourceId) : rule.targetId;
        const indexed = store.get(lookup) ?? [];
        indexed.push(assignment);
        store.set(lookup, indexed);
      } else throw new IntegrationContractError(`Unsupported v2 origin ${rule.originKind}`);
    }
    for (const [lookup, rules] of native) this.native.set(lookup, new AssignmentIndex(rules));
    for (const rules of this.assignments.values()) rules.sort((a, b) => a.groupCode.localeCompare(b.groupCode) || b.priority - a.priority || numericOrder(a, b));
  }

  listReferenceTypes(typeCodes: readonly string[]): readonly ClassificationReferenceTypeRecord[] {
    return this.referenceTypes.filter((type) => typeCodes.includes(type.code));
  }

  decisions(sourceId: string, inputs: readonly ClassificationLookupInput[]): readonly ClassificationMappingMatchRecord[] {
    return inputs.flatMap((input) => {
      const found = this.exact.get(key(sourceId, input.typeCode, input.scope, input.normalizedSourceValue, input.contextKey));
      return found === undefined ? [] : [{ ...found, candidateKey: input.candidateKey }];
    });
  }
  rules(sourceId: string): readonly ClassificationRuleRecord[] { return this.classification.get(sourceId) ?? []; }
  mapping(targetId: string, referenceId: string, scope: string) { return this.mappings.get(key(targetId, referenceId, scope)) ?? null; }
  projections(targetId: string, resolutions: readonly { resolutionKind: "mapping" | "rule"; resolutionId: string; referenceId: string }[]) {
    const specific = new Map<string, TargetClassificationProjectionRecord>();
    const canonical = new Map<string, TargetReferenceProjectionRecord>();
    for (const resolution of resolutions) {
      for (const item of this.specific.get(key(targetId, resolution.resolutionKind, resolution.resolutionId)) ?? []) specific.set(item.id, item);
      for (const item of this.canonical.get(key(targetId, resolution.referenceId)) ?? []) canonical.set(item.id, item);
    }
    return [...[...specific.values()].sort(numericOrder), ...[...canonical.values()].sort(numericOrder)];
  }
  assignmentRules(targetId: string) { return this.assignments.get(targetId) ?? []; }
  nativeAssignments(targetId: string, product: UniversalProductDTO, source: RulesV2ProductSource) {
    const reader = rulesV2FieldReader(product, source);
    const rules = [...this.assignmentRules(targetId), ...(this.native.get(key(targetId, source.id))?.select(reader) ?? []),
      ...(this.native.get(key(targetId, null))?.select(reader) ?? [])];
    return resolveTargetAssignments(product, rules, reader);
  }
}
