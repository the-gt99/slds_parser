import type { JsonObject, UniversalProductDTO } from "../contracts/index.js";
import type { CachedExportControlPreflight, InternalProductRecord, SaveExportControlPreflightInput, SourceProductRecord, SourceRecord, TargetRecord } from "../repositories/index.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function termSummary(value: unknown): JsonObject {
  const term = record(value);
  return {
    termId: Number(term.termId ?? 0),
    name: String(term.name ?? ""),
  };
}

function removedImageSummary(value: unknown): JsonObject {
  const row = record(value);
  const image = record(row.actual);
  const url = [image.url, image.source_url, image.origin_url]
    .find((candidate) => typeof candidate === "string" && candidate.trim() !== "");
  const position = Number(row.position);
  return {
    position: Number.isSafeInteger(position) && position >= 0 ? position + 1 : null,
    url: typeof url === "string" ? url : null,
  };
}

function deactivatedVariationSummary(value: unknown): JsonObject {
  const row = record(value);
  const current = record(row.actual);
  const size = String(row.size ?? "");
  const sizeLabel = String(row.sizeLabel ?? "").trim();
  return {
    size,
    label: sizeLabel || size,
    regularPrice: String(current.regularPrice ?? ""),
    stockStatus: String(current.stockStatus ?? ""),
    stockQuantity: current.stockQuantity === null || current.stockQuantity === undefined
      ? null
      : Number(current.stockQuantity),
  };
}

function imageUrl(product: UniversalProductDTO): string | null {
  return product.images[0]?.url?.trim() || null;
}

export function summarizeExportControlPreflight(input: {
  readonly target: TargetRecord;
  readonly source: SourceRecord;
  readonly sourceProduct: SourceProductRecord;
  readonly internal: InternalProductRecord;
  readonly configurationRevision: string;
  readonly preview: unknown;
  readonly wordpressCheckedAt: string | null;
  readonly wordpressStateHash: string | null;
  readonly usedCachedWordPress: boolean;
  readonly preflightCache: JsonObject;
  readonly cachedPreflight?: CachedExportControlPreflight;
}): SaveExportControlPreflightInput {
  const preview = record(input.preview);
  const readiness = record(preview.readiness);
  const comparison = record(preview.comparison);
  const ready = readiness.ready === true;
  const fields = list(comparison.fields).map(record).filter((item) => item.changed === true);
  const taxonomies = list(comparison.taxonomies).map(record).filter((item) => item.changed === true);
  const images = record(comparison.images);
  const imageRows = list(images.rows).map(record).filter((item) => item.status !== "unchanged");
  const variations = record(comparison.variations);
  const variationRows = list(variations.rows).map(record).filter((item) => item.status !== "unchanged");
  const flags = new Set<string>();
  for (const field of fields) flags.add(`field:${String(field.field ?? "unknown")}`);
  let taxonomyAddedCount = 0;
  let taxonomyRemovedCount = 0;
  const taxonomySummary = taxonomies.map((taxonomy) => {
    const name = String(taxonomy.taxonomy ?? "unknown");
    const added = list(taxonomy.added).map(termSummary);
    const removed = list(taxonomy.removed).map(termSummary);
    taxonomyAddedCount += added.length;
    taxonomyRemovedCount += removed.length;
    flags.add(`taxonomy:${name}`);
    if (added.length > 0) flags.add(`taxonomy_added:${name}`);
    if (removed.length > 0) flags.add(`taxonomy_removed:${name}`);
    return { taxonomy: name, added, removed } satisfies JsonObject;
  });
  if (imageRows.length > 0) flags.add("images");
  const addedImages = imageRows.filter((item) => item.status === "add").length;
  const removedImages = imageRows.filter((item) => item.status === "remove").length;
  const changedImages = imageRows.filter((item) => item.status === "change").length;
  const removedImageItems = imageRows.filter((item) => item.status === "remove").map(removedImageSummary);
  if (addedImages > 0) flags.add("images_added");
  if (removedImages > 0) flags.add("images_removed");
  const cachedVariationSummary = input.cachedPreflight === undefined
    ? null
    : record(input.cachedPreflight.changeSummary.variations);
  const addedVariations = cachedVariationSummary === null
    ? variationRows.filter((item) => item.status === "add").length
    : Number(cachedVariationSummary.added ?? 0);
  const changedVariations = cachedVariationSummary === null
    ? variationRows.filter((item) => item.status === "change").length
    : Number(cachedVariationSummary.changed ?? 0);
  const deactivatedVariations = cachedVariationSummary === null
    ? variationRows.filter((item) => item.status === "deactivate").length
    : input.cachedPreflight!.deactivatedVariationCount;
  const deactivatedVariationItems = variationRows
    .filter((item) => item.status === "deactivate")
    .map(deactivatedVariationSummary);
  const effectiveDeactivatedVariationItems = cachedVariationSummary === null
    ? deactivatedVariationItems
    : list(cachedVariationSummary.deactivatedItems) as readonly JsonObject[];
  if (addedVariations > 0) flags.add("variation_added");
  if (changedVariations > 0) flags.add("variation_changed");
  if (deactivatedVariations > 0) flags.add("variation_deactivated");
  const willCreate = typeof preview.willCreate === "boolean" ? preview.willCreate : null;
  if (willCreate === true) flags.add("new_product");
  const variationChangeCount = cachedVariationSummary === null
    ? variationRows.length
    : input.cachedPreflight!.variationChangeCount;
  const hasChanges = fields.length + taxonomies.length + imageRows.length + variationChangeCount > 0;
  if (ready && !hasChanges && willCreate !== true) flags.add("no_changes");
  const identityFieldChanged = fields.some((field) => ["title", "slug", "sku"].includes(String(field.field)));
  const riskLevel = taxonomyRemovedCount > 0 || deactivatedVariations > 0 || removedImages > 0
    ? "danger" as const
    : willCreate === true || identityFieldChanged || imageRows.length > 0
      ? "review" as const
      : "none" as const;
  const payloadHash = typeof preview.payloadHash === "string" ? preview.payloadHash : null;
  const externalId = preview.externalId === null || preview.externalId === undefined ? null : String(preview.externalId);
  const matchedBy = typeof preview.matchedBy === "string" ? preview.matchedBy : null;
  const title = input.internal.data.title.trim() || input.sourceProduct.sourceKey;
  return {
    targetId: input.target.id,
    internalProductId: input.internal.id,
    sourceProductId: input.sourceProduct.id,
    sourceCode: input.source.code,
    sourceExternalId: input.sourceProduct.externalId,
    title,
    imageUrl: imageUrl(input.internal.data),
    status: ready ? "ready" : "blocked",
    phase: String(readiness.phase ?? "unknown"),
    internalContentHash: input.internal.contentHash,
    configurationRevision: input.configurationRevision,
    payloadHash,
    externalId,
    willCreate,
    matchedBy,
    riskLevel,
    changeFlags: [...flags].sort(),
    fieldChangeCount: fields.length,
    taxonomyAddedCount,
    taxonomyRemovedCount,
    imageChangeCount: imageRows.length,
    variationChangeCount,
    deactivatedVariationCount: deactivatedVariations,
    blockers: list(readiness.blockers) as SaveExportControlPreflightInput["blockers"],
    changeSummary: {
      fields: fields.map((field) => String(field.field ?? "unknown")),
      taxonomies: taxonomySummary,
      images: { added: addedImages, changed: changedImages, removed: removedImages, removedItems: removedImageItems },
      variations: {
        added: addedVariations,
        changed: changedVariations,
        deactivated: deactivatedVariations,
        deactivatedItems: effectiveDeactivatedVariationItems,
      },
    },
    wordpressCheckedAt: input.wordpressCheckedAt,
    wordpressStateHash: input.wordpressStateHash,
    usedCachedWordPress: input.usedCachedWordPress,
    preflightCache: input.preflightCache,
  };
}
