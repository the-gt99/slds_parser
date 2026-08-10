export function suggestRuleConditions(item) {
  if (item.typeCode === "category") {
    const conditions = [{ field: "sourceValue", operator: "equals", value: item.sourceValue }];
    for (const key of ["productType", "productCategory", "audience"]) {
      if (typeof item.context?.[key] === "string" && item.context[key]) {
        conditions.push({ field: `context.${key}`, operator: "equals", value: item.context[key] });
      }
    }
    return conditions;
  }

  if (item.typeCode === "model") {
    const conditions = [];
    if (typeof item.context?.brand === "string" && item.context.brand) {
      conditions.push({ field: "context.brand", operator: "equals", value: item.context.brand });
    }
    if (typeof item.examples?.[0]?.evidence?.title === "string" && item.examples[0].evidence.title) {
      conditions.push({ field: "evidence.title", operator: "contains", value: item.sourceValue });
    }
    if (conditions.length) return conditions;
  }

  return [{ field: "sourceValue", operator: "equals", value: item.sourceValue }];
}
