import type { JsonObject } from "../contracts/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type { WordPressUpsertPayloadPreview } from "../integrations/wordpress/index.js";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function termIds(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((item) => Number(object(item).term_id)).filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
  const ids = object(value).term_ids;
  return Array.isArray(ids) ? ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b) : [];
}

function sizeKey(value: unknown): string | null {
  const size = object(value);
  const taxonomy = String(size.taxonomy ?? "");
  const termId = Number(size.term_id);
  return /^pa_[a-z0-9_-]+$/u.test(taxonomy) && Number.isSafeInteger(termId) && termId > 0 ? `${taxonomy}:${termId}` : null;
}

function currentVariationSize(value: unknown): string | null {
  const attributes = object(value).attributes;
  if (!Array.isArray(attributes)) return null;
  const keys = attributes.map((item) => sizeKey(object(item))).filter((item): item is string => item !== null);
  return keys.length === 1 ? keys[0]! : null;
}

function imageKey(value: unknown): string {
  const image = object(value);
  return String(image.content_hash || image.source_content_hash || image.source_url || image.origin_url || image.url || image.import_name || "");
}

export function buildWordPressCatalogAudit(draft: WordPressUpsertPayloadPreview, snapshot: JsonObject): JsonObject {
  const payload = object(draft.payload);
  const proposed = object(payload.product);
  const current = object(object(snapshot).product);
  const managed = new Set(Array.isArray(payload.managed_fields) ? payload.managed_fields.map(String) : []);
  const fieldMap: Readonly<Record<string, string>> = { description: "description_html", short_description: "short_description_html" };
  const fields = [...managed].map((managedField) => {
    const field = fieldMap[managedField] ?? managedField;
    const before = current[field] ?? null;
    const after = proposed[field] ?? null;
    return { field, before, after, changed: hashStableJson(before as never) !== hashStableJson(after as never) };
  });

  const proposedTaxonomies = object(proposed.taxonomies);
  const currentTaxonomies = object(current.taxonomies);
  const taxonomyNames = Object.keys(proposedTaxonomies).sort();
  const taxonomies = taxonomyNames.map((taxonomy) => {
    const before = termIds(currentTaxonomies[taxonomy]);
    const after = termIds(proposedTaxonomies[taxonomy]);
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    return {
      taxonomy,
      before,
      after,
      added: after.filter((id) => !beforeSet.has(id)),
      removed: before.filter((id) => !afterSet.has(id)),
      changed: before.join(",") !== after.join(","),
    };
  });

  const proposedVariationItems = object(payload.variations).items;
  const proposedSizes = new Set((Array.isArray(proposedVariationItems) ? proposedVariationItems : [])
    .map((item) => sizeKey(object(item).size)).filter((item): item is string => item !== null));
  const currentSizes = new Set((Array.isArray(current.variations) ? current.variations : [])
    .map(currentVariationSize).filter((item): item is string => item !== null));
  const variationAdded = [...proposedSizes].filter((key) => !currentSizes.has(key)).sort();
  const variationRemoved = [...currentSizes].filter((key) => !proposedSizes.has(key)).sort();

  const proposedImages = (Array.isArray(proposed.images) ? proposed.images : []).map(imageKey).filter(Boolean);
  const currentImages = (Array.isArray(current.images) ? current.images : []).map(imageKey).filter(Boolean);
  const imagesChanged = proposedImages.join("\u0000") !== currentImages.join("\u0000");
  const changedFieldCount = fields.filter((item) => item.changed).length;
  const changedTaxonomyCount = taxonomies.filter((item) => item.changed).length;
  const hasRemoval = taxonomies.some((item) => item.removed.length > 0) || variationRemoved.length > 0;
  const hasChanges = changedFieldCount > 0 || changedTaxonomyCount > 0 || imagesChanged || variationAdded.length > 0 || variationRemoved.length > 0;
  const result = {
    risk: hasRemoval ? "danger" : hasChanges ? "review" : "none",
    summary: {
      changed_field_count: changedFieldCount,
      changed_taxonomy_count: changedTaxonomyCount,
      images_changed: imagesChanged,
      variation_added_count: variationAdded.length,
      variation_removed_count: variationRemoved.length,
      ignored_size_count: draft.ignoredSizeVariants.length,
    },
    fields,
    taxonomies,
    images: { before: currentImages, after: proposedImages, changed: imagesChanged },
    variations: { before: [...currentSizes].sort(), after: [...proposedSizes].sort(), added: variationAdded, removed: variationRemoved },
    ignored_size_variants: draft.ignoredSizeVariants.map((item) => ({ ...item, audience: item.audience ?? null })),
  };
  return result as unknown as JsonObject;
}
