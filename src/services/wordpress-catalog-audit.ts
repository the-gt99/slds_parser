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

function termItems(value: unknown): Array<{ readonly term_id: number; readonly name: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => object(item)).map((item) => ({
    term_id: Number(item.term_id),
    name: typeof item.name === "string" && item.name.trim() !== "" ? item.name : null,
  })).filter((item) => Number.isSafeInteger(item.term_id) && item.term_id > 0);
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

function imageItem(value: unknown): { readonly key: string; readonly url: string | null } {
  const item = object(value);
  const url = [item.url, item.source_url, item.origin_url].find((candidate) => typeof candidate === "string" && candidate !== "");
  return { key: imageKey(value), url: typeof url === "string" ? url : null };
}

function proposedVariation(value: unknown) {
  const item = object(value);
  return {
    source_variant_key: typeof item.source_variant_key === "string" ? item.source_variant_key : null,
    price: Object.keys(object(item.price)).length === 0 ? null : object(item.price),
    inventory: Object.keys(object(item.inventory)).length === 0 ? null : object(item.inventory),
  };
}

function currentVariation(value: unknown) {
  const item = object(value);
  return {
    variation_id: Number.isSafeInteger(Number(item.variation_id)) ? Number(item.variation_id) : null,
    regular_price: item.regular_price === null || item.regular_price === undefined ? null : String(item.regular_price),
    stock_status: item.stock_status === null || item.stock_status === undefined ? null : String(item.stock_status),
    stock_quantity: typeof item.stock_quantity === "number" ? item.stock_quantity : null,
  };
}

function expectedStockStatus(inventory: Record<string, unknown> | null): string | null {
  if (inventory === null) return null;
  if (inventory.availability === "available") return "instock";
  if (inventory.availability === "unavailable") return "outofstock";
  if (inventory.availability === "backorder") return "onbackorder";
  return null;
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
      before_terms: termItems(currentTaxonomies[taxonomy]),
      changed: before.join(",") !== after.join(","),
    };
  });

  const proposedVariationItems = Array.isArray(object(payload.variations).items) ? object(payload.variations).items as unknown[] : [];
  const currentVariationItems = Array.isArray(current.variations) ? current.variations : [];
  const proposedBySize = new Map(proposedVariationItems.flatMap((item) => {
    const key = sizeKey(object(item).size);
    return key === null ? [] : [[key, proposedVariation(item)] as const];
  }));
  const currentBySize = new Map(currentVariationItems.flatMap((item) => {
    const key = currentVariationSize(item);
    return key === null ? [] : [[key, currentVariation(item)] as const];
  }));
  const proposedSizes = new Set(proposedBySize.keys());
  const currentSizes = new Set(currentBySize.keys());
  const variationAdded = [...proposedSizes].filter((key) => !currentSizes.has(key)).sort();
  const variationRemoved = [...currentSizes].filter((key) => !proposedSizes.has(key)).sort();
  const variationItems = [...new Set([...currentSizes, ...proposedSizes])].sort().map((size) => {
    const before = currentBySize.get(size) ?? null;
    const after = proposedBySize.get(size) ?? null;
    const expectedStatus = expectedStockStatus(after?.inventory ?? null);
    const expectedQuantity = typeof after?.inventory?.quantity === "number" ? after.inventory.quantity : null;
    const stockChanged = before !== null && after !== null && (
      (expectedStatus !== null && before.stock_status !== expectedStatus)
      || (expectedQuantity !== null && before.stock_quantity !== expectedQuantity)
    );
    const state = before === null ? "added" : after === null ? "removed" : "existing";
    return {
      size, state, before, after,
      price_managed: after?.price !== null && after?.price !== undefined,
      stock_changed: stockChanged,
      changed: state !== "existing" || stockChanged || (after?.price !== null && after?.price !== undefined),
    };
  });

  const proposedImageItems = (Array.isArray(proposed.images) ? proposed.images : []).map(imageItem).filter((item) => item.key !== "");
  const currentImageItems = (Array.isArray(current.images) ? current.images : []).map(imageItem).filter((item) => item.key !== "");
  const proposedImages = proposedImageItems.map((item) => item.key);
  const currentImages = currentImageItems.map((item) => item.key);
  const imagesChanged = proposedImages.join("\u0000") !== currentImages.join("\u0000");
  const changedFieldCount = fields.filter((item) => item.changed).length;
  const changedTaxonomyCount = taxonomies.filter((item) => item.changed).length;
  const hasRemoval = taxonomies.some((item) => item.removed.length > 0) || variationRemoved.length > 0;
  const stockChangedCount = variationItems.filter((item) => item.stock_changed).length;
  const priceManagedCount = variationItems.filter((item) => item.price_managed).length;
  const hasChanges = changedFieldCount > 0 || changedTaxonomyCount > 0 || imagesChanged || variationAdded.length > 0 || variationRemoved.length > 0 || stockChangedCount > 0;
  const result = {
    risk: hasRemoval ? "danger" : hasChanges ? "review" : "none",
    summary: {
      changed_field_count: changedFieldCount,
      changed_taxonomy_count: changedTaxonomyCount,
      images_changed: imagesChanged,
      variation_added_count: variationAdded.length,
      variation_removed_count: variationRemoved.length,
      variation_stock_changed_count: stockChangedCount,
      variation_price_managed_count: priceManagedCount,
      ignored_size_count: draft.ignoredSizeVariants.length,
    },
    fields,
    taxonomies,
    images: { before: currentImages, after: proposedImages, before_items: currentImageItems, after_items: proposedImageItems, changed: imagesChanged },
    variations: { before: [...currentSizes].sort(), after: [...proposedSizes].sort(), added: variationAdded, removed: variationRemoved, items: variationItems },
    ignored_size_variants: draft.ignoredSizeVariants.map((item) => ({ ...item, audience: item.audience ?? null })),
  };
  return result as unknown as JsonObject;
}
