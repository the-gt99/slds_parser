import type { EntityId, ReferenceCandidateDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type {
  ClassificationRuleConditionRecord,
  ClassificationRuleRecord,
} from "../repositories/index.js";

export function normalizeClassificationValue(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

function candidateField(candidate: ReferenceCandidateDTO, field: string): string {
  if (field === "sourceValue") return candidate.sourceValue;
  if (field === "scope") return candidate.scope;
  if (field === "subjectKind") return candidate.subjectKind;

  const separator = field.indexOf(".");
  if (separator <= 0 || separator === field.length - 1) return "";
  const container = field.slice(0, separator);
  const key = field.slice(separator + 1);
  const values = container === "context"
    ? candidate.context
    : container === "evidence"
      ? candidate.evidence
      : null;
  if (values === null) return "";
  const value = values[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

export function matchesClassificationCondition(
  candidate: ReferenceCandidateDTO,
  condition: ClassificationRuleConditionRecord,
): boolean {
  if (!/^(?:sourceValue|scope|subjectKind|(?:context|evidence)\.[a-zA-Z][a-zA-Z0-9_-]*)$/u.test(condition.field)) {
    throw new IntegrationContractError(`Invalid classification rule field: ${condition.field}`);
  }
  if (condition.value.trim() === "") {
    throw new IntegrationContractError(`Classification rule value is required for ${condition.field}`);
  }

  const actual = candidateField(candidate, condition.field);
  const expected = condition.value;
  switch (condition.operator) {
    case "equals":
      return normalizeClassificationValue(actual) === normalizeClassificationValue(expected);
    case "contains":
      return normalizeClassificationValue(actual).includes(normalizeClassificationValue(expected));
    case "all_words": {
      const haystack = normalizeClassificationValue(actual);
      const words = normalizeClassificationValue(expected).split(/\s+/u).filter(Boolean);
      return words.length > 0 && words.every((word) => haystack.includes(word));
    }
    case "regex": {
      if (expected.length > 256) {
        throw new IntegrationContractError("Classification regex must contain no more than 256 characters");
      }
      try {
        return new RegExp(expected, "iu").test(actual);
      } catch (error) {
        throw new IntegrationContractError(
          `Invalid classification regex: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    default:
      throw new IntegrationContractError(`Unknown classification rule operator: ${String(condition.operator)}`);
  }
}

export function matchesClassificationRule(
  candidate: ReferenceCandidateDTO,
  conditions: readonly ClassificationRuleConditionRecord[],
): boolean {
  return conditions.length > 0
    && conditions.every((condition) => matchesClassificationCondition(candidate, condition));
}

export function classificationRuleScore(
  sourceId: EntityId,
  rule: Pick<ClassificationRuleRecord, "sourceId" | "priority" | "conditions">,
): readonly [number, number, number] {
  return [rule.priority, rule.sourceId === sourceId ? 1 : 0, rule.conditions.length];
}

export function compareClassificationRuleScore(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
