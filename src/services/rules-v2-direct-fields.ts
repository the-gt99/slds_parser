import type { RuleV2Record } from "../repositories/index.js";

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
