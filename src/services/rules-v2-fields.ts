import { IntegrationContractError } from "../core/errors/index.js";

export const rulesV2TargetEntities: Readonly<Record<string, string>> = {
  "product.category": "product_categories", "product.tag": "tags", "product.brand": "brands", "product.model": "models",
  "product.color": "colors", "product.material": "materials", "product.activity": "activities",
  "product.shoe_height": "shoe_heights", "product.season": "seasons",
};

/** Scalar paths of the public DTO; an unknown path must never behave like an absent value. */
export const commonRulePaths = new Set([
  "source.code", "source.productId", "source.sourceKey", "source.externalId", "title", "description", "sku",
  ...["brand", "model", "family", "category", "color", "material", "audience", "ageGroups", "tags"].map((key) => `characteristics.${key}`),
  ...["url", "alt", "position"].map((key) => `images.*.${key}`),
  ...["sourceVariantId", "sku", "size.value", "size.system", "price.amount", "price.currency", "availability", "quantity"].map((key) => `variants.*.${key}`),
]);

export function validateRulesV2Field(field: string): void {
  if (field.startsWith("common.")) {
    if (commonRulePaths.has(field.slice(7))) return;
  } else if (/^product\.(?:title|description|sku)$/u.test(field)
    || /^product\.(?:attribute|metadata|fact)\.[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)*$/u.test(field)
    || /^resolved\.[a-z][a-z0-9_]*$/u.test(field)
    || /^candidate\.[a-z][a-z0-9_]*\.(?:sourceValue|(?:context|evidence)\.[a-zA-Z][a-zA-Z0-9_-]*)$/u.test(field)) return;
  throw new IntegrationContractError(`Unsupported rules v2 field: ${field}`);
}
