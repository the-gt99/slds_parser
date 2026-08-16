import type { TargetAssignmentDTO, UniversalProductDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { TargetAssignmentConditionRecord, TargetAssignmentRuleRecord } from "../repositories/index.js";

function normalize(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizePhrase(value: string): string {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function scalar(value: unknown): string[] {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [String(value)] : [];
}

export function targetAssignmentFieldValues(product: UniversalProductDTO, field: string): readonly string[] {
  const parts = field.split(".");
  if (parts[0] === "resolved" && parts.length === 2) {
    return product.classification?.resolved.filter((item) => item.typeCode === parts[1]).map((item) => item.referenceValueId) ?? [];
  }
  if (parts[0] === "product" && parts[1] === "attribute" && parts.length === 3) {
    return scalar(product.attributes[parts[2]!]);
  }
  if (parts[0] === "product" && parts[1] === "metadata" && parts.length === 3) {
    return scalar(product.metadata[parts[2]!]);
  }
  if (parts[0] === "product" && parts[1] === "fact" && parts.length === 3) {
    return scalar(product.sourceFacts?.[parts[2]!]);
  }
  if (parts[0] !== "candidate" || parts.length < 3) {
    throw new IntegrationContractError(`Unsupported target assignment field: ${field}`);
  }
  const candidates = product.referenceCandidates.filter((item) => item.typeCode === parts[1]);
  if (parts.length === 3 && parts[2] === "sourceValue") return candidates.map((item) => item.sourceValue);
  if (parts.length === 4 && (parts[2] === "context" || parts[2] === "evidence")) {
    return candidates.flatMap((item) => scalar(item[parts[2] as "context" | "evidence"][parts[3]!]));
  }
  throw new IntegrationContractError(`Unsupported target assignment field: ${field}`);
}

export function matchesTargetAssignmentCondition(product: UniversalProductDTO, condition: TargetAssignmentConditionRecord): boolean {
  if (condition.values.length === 0 || condition.values.some((value) => value.trim() === "")) {
    throw new IntegrationContractError(`Target assignment condition ${condition.field} requires non-empty values`);
  }
  const actual = new Set(targetAssignmentFieldValues(product, condition.field).map(normalize));
  const expected = condition.values.map(normalize);
  if (condition.operator === "equals") {
    if (expected.length !== 1) throw new IntegrationContractError(`equals requires one value for ${condition.field}`);
    return actual.has(expected[0]!);
  }
  if (condition.operator === "one_of") return expected.some((value) => actual.has(value));
  if (condition.operator === "contains_phrase") {
    const phrases = condition.values.map(normalizePhrase);
    return targetAssignmentFieldValues(product, condition.field).some((value) => {
      const actualPhrase = ` ${normalizePhrase(value)} `;
      return phrases.some((phrase) => actualPhrase.includes(` ${phrase} `));
    });
  }
  throw new IntegrationContractError(`Unsupported target assignment operator: ${String(condition.operator)}`);
}

export function resolveTargetAssignments(
  product: UniversalProductDTO,
  rules: readonly TargetAssignmentRuleRecord[],
): readonly TargetAssignmentDTO[] {
  const matching = rules.filter((rule) => rule.enabled && rule.conditions.every((condition) => matchesTargetAssignmentCondition(product, condition)));
  const groups = new Map<string, TargetAssignmentRuleRecord[]>();
  for (const rule of matching) groups.set(rule.groupCode, [...(groups.get(rule.groupCode) ?? []), rule]);
  const result: TargetAssignmentDTO[] = [];
  for (const [groupCode, groupRules] of groups) {
    const highest = Math.max(...groupRules.map((rule) => rule.priority));
    const winners = groupRules.filter((rule) => rule.priority === highest);
    if (winners.length !== 1) {
      throw new IntegrationContractError(`Target assignment group ${groupCode} has ${winners.length} equally prioritized matching rules`);
    }
    const winner = winners[0]!;
    if (winner.actions.length === 0) {
      throw new IntegrationContractError(`Target assignment rule ${winner.id} has no active dictionary actions`);
    }
    for (const action of winner.actions) {
      result.push({
        ruleId: winner.id,
        groupCode,
        targetScope: action.targetScope,
        externalValue: action.externalValue,
        mode: action.mode,
      });
    }
  }
  return result;
}
