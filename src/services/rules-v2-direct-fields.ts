import type { RuleV2Record } from "../repositories/index.js";

type RuleV2ConditionGroup = RuleV2Record["conditionGroups"][number];

const sourceValueFields: Readonly<Record<string, string>> = {
  brand: "common.characteristics.brand",
  model: "common.characteristics.model",
  category: "common.characteristics.category",
  color: "common.characteristics.color",
  material: "common.characteristics.material",
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
};

/** Returns null when the public DTO cannot express a migrated candidate condition exactly. */
export function directRulesV2Field(field: string): string | null {
  const match = /^candidate\.([a-z][a-z0-9_]*)\.(sourceValue|context\.([a-zA-Z][a-zA-Z0-9_-]*))$/u.exec(field);
  if (match === null) return null;
  return match[2] === "sourceValue" ? sourceValueFields[match[1]!] ?? null : contextFields[match[3]!] ?? null;
}

export function directRulesV2Conditions(groups: readonly RuleV2ConditionGroup[]): readonly RuleV2ConditionGroup[] | null {
  const translated: RuleV2ConditionGroup[] = [];
  for (const group of groups) {
    const conditions = [];
    for (const condition of group.conditions) {
      const field = directRulesV2Field(condition.field);
      if (field === null) return null;
      conditions.push({ ...condition, field });
    }
    translated.push({ ...group, conditions });
  }
  return translated;
}
