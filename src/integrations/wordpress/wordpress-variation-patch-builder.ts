import type { JsonObject } from "../../contracts/index.js";
import { IntegrationContractError } from "../../core/errors/index.js";
import type { WordPressVariationPatchDraft } from "./wordpress-exporter.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function matchExistingWordPressVariations(
  draft: WordPressVariationPatchDraft,
  snapshot: JsonObject,
): { readonly items: readonly JsonObject[]; readonly ignored: readonly JsonObject[] } {
  const product = record(snapshot.product);
  const variations = Array.isArray(product.variations) ? product.variations.map(record) : [];
  if (draft.deactivateAll) {
    const items: JsonObject[] = [];
    const ignored: JsonObject[] = [...draft.ignored];
    for (const variation of variations) {
      const variationId = positiveInteger(variation.variation_id);
      const attributes = Array.isArray(variation.attributes)
        ? variation.attributes.map(record).flatMap((attribute) => {
          const taxonomy = String(attribute.taxonomy ?? "");
          const termId = positiveInteger(attribute.term_id);
          return /^pa_[a-z0-9_-]+$/u.test(taxonomy) && termId !== null ? [{ taxonomy, termId }] : [];
        })
        : [];
      if (variationId === null || attributes.length !== 1) {
        ignored.push({ variationId, reason: "Вариацию нельзя безопасно снять с продажи: не найден единственный атрибут размера" });
        continue;
      }
      const size = attributes[0]!;
      items.push({
        variation_id: variationId,
        size: { taxonomy: size.taxonomy, term_id: size.termId },
        inventory: { availability: "unavailable", quantity: 0 },
      });
    }
    return { items, ignored };
  }
  const bySize = new Map<string, Record<string, unknown>[]>();
  for (const variation of variations) {
    const variationId = positiveInteger(variation.variation_id);
    if (variationId === null || !Array.isArray(variation.attributes)) continue;
    for (const rawAttribute of variation.attributes) {
      const attribute = record(rawAttribute);
      const taxonomy = String(attribute.taxonomy ?? "");
      const termId = positiveInteger(attribute.term_id);
      if (!/^pa_[a-z0-9_-]+$/u.test(taxonomy) || termId === null) continue;
      const key = `${taxonomy}:${termId}`;
      bySize.set(key, [...(bySize.get(key) ?? []), variation]);
    }
  }
  for (const [key, matches] of bySize) {
    if (matches.length > 1) throw new IntegrationContractError(`WordPress contains more than one variation for size ${key}`);
  }

  const items: JsonObject[] = [];
  const ignored: JsonObject[] = [...draft.ignored];
  for (const rawItem of draft.items) {
    const item = record(rawItem);
    const size = record(item.size);
    const taxonomy = String(size.taxonomy ?? "");
    const termId = positiveInteger(size.term_id);
    if (termId === null) throw new IntegrationContractError("Resolved WordPress variation size is invalid");
    const key = `${taxonomy}:${termId}`;
    const matches = bySize.get(key) ?? [];
    if (matches.length === 0) {
      ignored.push({ sourceVariantKey: String(item.source_variant_key ?? ""), size: key, reason: "Размера нет в WordPress; новый размер не создаётся" });
      continue;
    }
    const variationId = positiveInteger(matches[0]!.variation_id)!;
    items.push({
      variation_id: variationId,
      size: { taxonomy, term_id: termId },
      ...(item.price === null || item.price === undefined ? {} : { price: item.price as JsonObject }),
      ...(item.inventory === null || item.inventory === undefined ? {} : { inventory: item.inventory as JsonObject }),
    });
  }
  const sourceSizes = new Set(draft.sourceTargetSizes);
  const knownSizes = new Set(draft.knownTargetSizes);
  for (const [key, matches] of bySize) {
    if (!knownSizes.has(key) || sourceSizes.has(key)) continue;
    const [taxonomy, termIdText] = key.split(":");
    items.push({
      variation_id: positiveInteger(matches[0]!.variation_id)!,
      size: { taxonomy: taxonomy!, term_id: Number(termIdText) },
      inventory: { availability: "unavailable", quantity: 0 },
    });
  }
  return { items, ignored };
}
