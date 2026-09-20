import type { UniversalProductDTO } from "../contracts/index.js";
import type { RuleV2Record } from "../repositories/index.js";
import { matchesTargetAssignmentCondition } from "./target-assignment-rule-matcher.js";

type RuleV2ConditionGroup = RuleV2Record["conditionGroups"][number];

const sourceValueFields: Readonly<Record<string, string>> = {
  brand: "common.characteristics.brand",
  model: "common.characteristics.model",
  category: "common.characteristics.category",
  color: "common.characteristics.color",
  material: "common.characteristics.material",
  activity: "common.characteristics.activities",
  shoe_height: "common.characteristics.shoeHeight",
  tag: "common.characteristics.tags",
  designer: "product.fact.designer",
  merchandising_category: "product.attribute.categoryRaw",
};

const contextFields: Readonly<Record<string, string>> = {
  brand: "common.characteristics.brand",
  family: "common.characteristics.family",
  audience: "common.characteristics.audience",
  productType: "product.attribute.productType",
  productCategory: "product.attribute.productCategory",
  route: "product.metadata.route",
  ageGroups: "product.attribute.ageGroupsJoined",
};

/** Returns null when the public DTO cannot express a migrated candidate condition exactly. */
export function directRulesV2Field(field: string): string | null {
  const match = /^candidate\.([a-z][a-z0-9_]*)\.(sourceValue|context\.([a-zA-Z][a-zA-Z0-9_-]*))$/u.exec(field);
  if (match === null) return null;
  return match[2] === "sourceValue" ? sourceValueFields[match[1]!] ?? null : contextFields[match[3]!] ?? null;
}

export function directRulesV2Conditions(rule: Pick<RuleV2Record, "conditionGroups" | "actions">): readonly RuleV2ConditionGroup[] | null {
  const translated: RuleV2ConditionGroup[] = [];
  for (const group of rule.conditionGroups) {
    const conditions = [];
    for (const condition of group.conditions) {
      const field = directRulesV2Field(condition.field);
      if (field === null) return null;
      conditions.push({ ...condition, field });
    }
    translated.push({ ...group, conditions });
  }
  const reference = rule.actions.find((action) => action.kind === "resolve_reference");
  if (reference?.kind !== "resolve_reference") return null;
  const sourceField = `candidate.${reference.referenceType}.sourceValue`;
  if (!rule.conditionGroups.some((group) => group.conditions.some((condition) => condition.field === sourceField))) {
    const direct = directRulesV2Field(sourceField);
    if (direct === null) return null;
    translated.push({ conditions: [{ field: direct, operator: "regex", values: [".+"] }] });
  }
  return translated;
}

/** Imported classifier operators are broader than the native assignment editor's operators. */
export function matchesDirectRulesV2Conditions(product: UniversalProductDTO, groups: readonly RuleV2ConditionGroup[],
  fieldValues: (field: string) => readonly string[]): boolean {
  const normalized = (value: string) => value.trim().normalize("NFKC").toLowerCase();
  return groups.every((group) => group.conditions.some((condition) => {
    const operator = String(condition.operator);
    if (operator === "contains" || operator === "all_words" || operator === "regex") {
      const actual = fieldValues(condition.field);
      if (condition.values.length === 0) return false;
      if (operator === "contains") return actual.some((value) => condition.values.some((expected) =>
        normalized(value).includes(normalized(expected))));
      if (operator === "all_words") return actual.some((value) => condition.values.some((expected) => {
        const words = normalized(expected).split(/\s+/u).filter(Boolean);
        return words.length > 0 && words.every((word) => normalized(value).includes(word));
      }));
      return actual.some((value) => condition.values.some((expected) => {
        if (expected.length > 256) throw new Error("Classification regex must contain no more than 256 characters");
        return new RegExp(expected, "iu").test(value);
      }));
    }
    return matchesTargetAssignmentCondition(product, condition, fieldValues);
  }));
}
