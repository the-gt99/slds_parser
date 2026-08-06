import type { EntityId, JsonObject, SourceDTO, SourceProductDTO, TargetDTO } from "../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type { TargetExporterRegistry } from "../core/registry/index.js";
import { buildWordPressUpsertPayload, WordPressExporter } from "../integrations/index.js";
import type { InternalProductRepository, SourceProductRepository, SourceRepository, TargetRepository } from "../repositories/index.js";
import type { TargetReferenceMappingService } from "./target-reference-mapping-service.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalized(item)]));
  }
  return value;
}

function different(expected: unknown, actual: unknown): boolean {
  return JSON.stringify(normalized(expected)) !== JSON.stringify(normalized(actual));
}

function sizeKey(value: unknown): string {
  const size = record(value);
  const taxonomy = String(size.taxonomy ?? "");
  const termId = Number(size.term_id);
  return taxonomy !== "" && Number.isSafeInteger(termId) && termId > 0 ? `${taxonomy}:${termId}` : "";
}

function snapshotVariations(value: unknown): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.flatMap((raw) => {
    const item = record(raw);
    const keys = Array.isArray(item.attributes) ? item.attributes.map(sizeKey).filter(Boolean) : [];
    return keys.length === 1 ? [[keys[0]!, item] as const] : [];
  }));
}

function variationDiff(plan: readonly JsonObject[], snapshot: unknown) {
  const planned = new Map(plan.flatMap((item) => {
    const key = sizeKey(item.size);
    return key === "" ? [] : [[key, item] as const];
  }));
  const actual = snapshotVariations(snapshot);
  const differences: Record<string, unknown>[] = [];
  const deactivated: string[] = [];
  for (const key of [...new Set([...planned.keys(), ...actual.keys()])].sort()) {
    const expected = planned.get(key) ?? null;
    const current = actual.get(key) ?? null;
    if (expected === null && current?.stock_status === "outofstock" && current.manage_stock === true && Number(current.stock_quantity) === 0) {
      deactivated.push(key);
      continue;
    }
    const state = (item: Record<string, unknown> | JsonObject | null) => item === null ? null : ({
      regularPrice: String(item.regular_price ?? ""), stockStatus: String(item.stock_status ?? ""),
      manageStock: item.manage_stock === true, stockQuantity: item.stock_quantity === null ? null : Number(item.stock_quantity),
    });
    if (different(state(expected), state(current))) differences.push({ size: key, expected: state(expected), actual: state(current) });
  }
  return { differences, deactivated };
}

function payloadTaxonomies(value: unknown): Record<string, number[]> {
  return Object.fromEntries(Object.entries(record(value)).map(([taxonomy, spec]) => [taxonomy, Array.isArray(record(spec).term_ids) ? (record(spec).term_ids as unknown[]).map(Number).sort((a, b) => a - b) : []]));
}

function snapshotTaxonomies(value: unknown): Record<string, number[]> {
  return Object.fromEntries(Object.entries(record(value)).map(([taxonomy, terms]) => [taxonomy, Array.isArray(terms) ? terms.map((term) => Number(record(term).term_id)).filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b) : []]));
}

function imageIdentity(value: unknown): string {
  const image = record(value);
  const url = typeof image.url === "string" ? image.url.trim() : "";
  const sourceUrl = typeof image.source_url === "string" ? image.source_url.trim() : "";
  const filename = typeof image.filename === "string" ? image.filename.trim() : "";
  const importName = typeof image.import_name === "string" ? image.import_name.trim() : "";
  return JSON.stringify({
    url,
    sourceUrl,
    filename: filename || importName,
  });
}

function imageDiff(expected: unknown, actual: unknown) {
  const expectedImages = Array.isArray(expected) ? expected : [];
  const actualImages = Array.isArray(actual) ? actual : [];
  const max = Math.max(expectedImages.length, actualImages.length);
  const differences: Record<string, unknown>[] = [];
  for (let index = 0; index < max; index++) {
    const expectedImage = expectedImages[index] ?? null;
    const actualImage = actualImages[index] ?? null;
    if (imageIdentity(expectedImage) !== imageIdentity(actualImage)) {
      differences.push({ position: index, expected: expectedImage, actual: actualImage });
    }
  }
  return {
    expectedCount: expectedImages.length,
    actualCount: actualImages.length,
    changed: differences.length > 0,
    differences,
  };
}

export class WordPressPreviewService {
  constructor(
    private readonly repositories: { readonly sources: SourceRepository; readonly sourceProducts: SourceProductRepository; readonly internalProducts: InternalProductRepository; readonly targets: TargetRepository },
    private readonly exporters: TargetExporterRegistry,
    private readonly mappings: TargetReferenceMappingService,
  ) {}

  async preview(sourceProductId: EntityId, targetId: EntityId) {
    const sourceProduct = await this.repositories.sourceProducts.getById(sourceProductId);
    if (sourceProduct === null) throw new EntityNotFoundError("Source product", sourceProductId);
    const source = await this.repositories.sources.getById(sourceProduct.sourceId);
    if (source === null) throw new EntityNotFoundError("Source", sourceProduct.sourceId);
    const internal = await this.repositories.internalProducts.findBySourceProductId(sourceProductId);
    if (internal === null) throw new IntegrationContractError("Product has not been processed");
    const target = await this.repositories.targets.getById(targetId);
    if (target === null) throw new EntityNotFoundError("Target", targetId);
    const exporter = this.exporters.get(target.exporterCode);
    if (!(exporter instanceof WordPressExporter)) throw new IntegrationContractError("Target does not use the WordPress exporter");
    const targetProduct = await this.repositories.targets.findTargetProduct(target.id, internal.id);
    const snapshot = await this.repositories.targets.findProductSnapshot(target.id, sourceProduct.id);
    const sourceDto: SourceDTO = { id: source.id, code: source.code, config: source.config };
    const sourceProductDto: SourceProductDTO = {
      id: sourceProduct.id, sourceId: sourceProduct.sourceId, sourceKey: sourceProduct.sourceKey,
      ...(sourceProduct.externalId === null ? {} : { externalId: sourceProduct.externalId }),
      ...(sourceProduct.slug === null ? {} : { slug: sourceProduct.slug }),
      ...(sourceProduct.url === null ? {} : { url: sourceProduct.url }), metadata: sourceProduct.discoveryMetadata,
    };
    const targetDto: TargetDTO = { id: target.id, code: target.code, config: target.config };
    const payload = await buildWordPressUpsertPayload({
      source: sourceDto, sourceProduct: sourceProductDto, target: targetDto, product: internal.data,
      references: {
        resolveReference: (input) => this.mappings.resolveTargetValue(target.id, input.referenceId, input.targetScope),
        resolveProjections: (inputs) => this.mappings.resolveTargetProjections(target.id, inputs),
      },
      ...(targetProduct?.externalId === null || targetProduct?.externalId === undefined ? {} : { existingExternalId: targetProduct.externalId }),
    });
    const preflight = await exporter.preflightPayload(payload);
    const product = record(payload.product);
    const current = record(snapshot?.payload.product);
    const variations = record(payload.variations);
    const expectedVariations = Array.isArray(variations.items) ? variations.items : [];
    const variationComparison = variationDiff(preflight.variationPlan, current.variations);
    const fields = ["title", "slug", "sku", "description_html", "short_description_html"].flatMap((field) =>
      different(product[field], current[field]) ? [{ field, expected: product[field] ?? null, actual: current[field] ?? null }] : []);
    const expectedTaxonomies = payloadTaxonomies(product.taxonomies);
    const actualTaxonomies = snapshotTaxonomies(current.taxonomies);
    const taxonomyDifferences = Object.keys(expectedTaxonomies).sort().flatMap((taxonomy) => different(expectedTaxonomies[taxonomy], actualTaxonomies[taxonomy] ?? [])
      ? [{ taxonomy, expected: expectedTaxonomies[taxonomy], actual: actualTaxonomies[taxonomy] ?? [] }] : []);
    return {
      target: { id: target.id, code: target.code, name: target.name, enabled: target.enabled },
      externalId: preflight.externalId, willCreate: preflight.willCreate,
      matchedBy: preflight.matchedBy, payloadHash: preflight.payloadHash,
      payload: { fields: Object.fromEntries(["title", "slug", "sku", "description_html", "short_description_html"].map((field) => [field, product[field] ?? null])), taxonomies: product.taxonomies ?? {}, images: product.images ?? [], activeVariations: expectedVariations },
      diff: {
        snapshotFetchedAt: snapshot?.fetchedAt ?? null,
        fields,
        taxonomyDifferences,
        images: imageDiff(product.images, current.images),
        variationDifferences: variationComparison.differences,
        deactivatedVariations: variationComparison.deactivated,
      },
    };
  }
}
