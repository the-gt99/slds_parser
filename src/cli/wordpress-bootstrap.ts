import { createApplication } from "../bootstrap.js";
import { loadWordPressTargetConfig } from "../config/index.js";
import type { JsonObject } from "../contracts/index.js";
import { hashStableJson } from "../core/utils/index.js";
import { buildWordPressUpsertPayload, WordPressExporter, WordPressProductSnapshotReader } from "../integrations/index.js";

function idsFromEnvironment(value: string | undefined, name: string): readonly string[] {
  const ids = [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > 100 || ids.some((id) => !/^\d+$/u.test(id) || BigInt(id) <= 0n)) {
    throw new Error(`${name} must contain from 1 to 100 comma-separated positive IDs`);
  }
  return ids;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function snapshotTaxonomies(value: unknown): Readonly<Record<string, readonly number[]>> {
  const result: Record<string, number[]> = {};
  for (const [taxonomy, rawTerms] of Object.entries(record(value))) {
    if (!Array.isArray(rawTerms)) continue;
    result[taxonomy] = rawTerms.flatMap((term) => {
      const id = Number(record(term).term_id);
      return Number.isSafeInteger(id) && id > 0 ? [id] : [];
    }).sort((left, right) => left - right);
  }
  return result;
}

function payloadTaxonomies(payload: JsonObject): Readonly<Record<string, readonly number[]>> {
  const result: Record<string, number[]> = {};
  for (const [taxonomy, rawSpec] of Object.entries(record(record(payload.product).taxonomies))) {
    const termIds = record(rawSpec).term_ids;
    if (Array.isArray(termIds)) result[taxonomy] = termIds.map(Number).sort((left, right) => left - right);
  }
  return result;
}

function taxonomyDifferences(payload: JsonObject, snapshot: JsonObject) {
  const expected = payloadTaxonomies(payload);
  const actual = snapshotTaxonomies(record(snapshot.product).taxonomies);
  return Object.keys(expected).sort().flatMap((taxonomy) => {
    const expectedIds = expected[taxonomy] ?? [];
    const actualIds = actual[taxonomy] ?? [];
    return JSON.stringify(expectedIds) === JSON.stringify(actualIds) ? [] : [{ taxonomy, expected: expectedIds, actual: actualIds }];
  });
}

function variationSizeTerms(value: unknown, source: "payload" | "snapshot"): readonly string[] {
  const items = source === "payload" ? record(value).items : value;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (source === "payload") {
      const size = record(record(item).size);
      const taxonomy = String(size.taxonomy ?? "");
      const id = Number(size.term_id);
      return taxonomy !== "" && Number.isSafeInteger(id) && id > 0 ? [`${taxonomy}:${id}`] : [];
    }
    const attributes = record(item).attributes;
    if (!Array.isArray(attributes)) return [];
    return attributes.flatMap((attribute) => {
      const item = record(attribute);
      const taxonomy = String(item.taxonomy ?? "");
      const id = Number(item.term_id);
      return taxonomy !== "" && Number.isSafeInteger(id) && id > 0 ? [`${taxonomy}:${id}`] : [];
    });
  }).sort((left, right) => left.localeCompare(right));
}

function fieldDifferences(payload: JsonObject, snapshot: JsonObject) {
  const expected = record(payload.product);
  const actual = record(snapshot.product);
  return ["title", "slug", "sku"].flatMap((field) => String(expected[field] ?? "") === String(actual[field] ?? "")
    ? []
    : [{ field, expected: String(expected[field] ?? ""), actual: String(actual[field] ?? "") }]);
}

interface VariationState {
  readonly regularPrice: string;
  readonly stockStatus: string;
  readonly manageStock: boolean;
  readonly stockQuantity: number | null;
}

function sizeTerm(value: unknown): string {
  const size = record(value);
  const taxonomy = String(size.taxonomy ?? "");
  const id = Number(size.term_id);
  return taxonomy !== "" && Number.isSafeInteger(id) && id > 0 ? `${taxonomy}:${id}` : "";
}

function plannedVariationStates(value: readonly JsonObject[]): ReadonlyMap<string, VariationState> {
  return new Map(value.flatMap((item) => {
    const key = sizeTerm(item.size);
    return key === "" ? [] : [[key, {
      regularPrice: String(item.regular_price ?? ""),
      stockStatus: String(item.stock_status ?? ""),
      manageStock: item.manage_stock === true,
      stockQuantity: item.stock_quantity === null ? null : Number(item.stock_quantity),
    }] as const];
  }));
}

function snapshotVariationStates(value: unknown): ReadonlyMap<string, VariationState> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.flatMap((rawItem) => {
    const item = record(rawItem);
    const attributes = Array.isArray(item.attributes) ? item.attributes.map(sizeTerm).filter(Boolean) : [];
    if (attributes.length !== 1) return [];
    return [[attributes[0]!, {
      regularPrice: String(item.regular_price ?? ""),
      stockStatus: String(item.stock_status ?? ""),
      manageStock: item.manage_stock === true,
      stockQuantity: item.stock_quantity === null ? null : Number(item.stock_quantity),
    }] as const];
  }));
}

function variationDifferences(plan: readonly JsonObject[], snapshot: unknown) {
  const expected = plannedVariationStates(plan);
  const actual = snapshotVariationStates(snapshot);
  return [...new Set([...expected.keys(), ...actual.keys()])].sort().flatMap((key) => {
    const expectedState = expected.get(key) ?? null;
    const actualState = actual.get(key) ?? null;
    return JSON.stringify(expectedState) === JSON.stringify(actualState) ? [] : [{ sizeTerm: key, expected: expectedState, actual: actualState }];
  });
}

const sourceProductIds = idsFromEnvironment(process.env.WORDPRESS_BOOTSTRAP_SOURCE_PRODUCT_IDS, "WORDPRESS_BOOTSTRAP_SOURCE_PRODUCT_IDS");
const [targetId] = idsFromEnvironment(process.env.WORDPRESS_BOOTSTRAP_TARGET_ID, "WORDPRESS_BOOTSTRAP_TARGET_ID");
const wordpress = loadWordPressTargetConfig();
if (wordpress === null) throw new Error("WordPress target environment is not configured");

const application = createApplication();
try {
  const target = await application.repositories.targets.getById(targetId!);
  if (target === null) throw new Error(`Target ${targetId} was not found`);
  if (target.exporterCode !== "wordpress") throw new Error(`Target ${targetId} does not use the WordPress exporter`);

  const products = await Promise.all(sourceProductIds.map(async (sourceProductId) => {
    const sourceProduct = await application.repositories.sourceProducts.getById(sourceProductId);
    if (sourceProduct === null) throw new Error(`Source product ${sourceProductId} was not found`);
    if (sourceProduct.externalId === null) throw new Error(`Source product ${sourceProductId} has no external ID`);
    const source = await application.repositories.sources.getById(sourceProduct.sourceId);
    if (source === null) throw new Error(`Source ${sourceProduct.sourceId} was not found`);
    return { source, sourceProduct };
  }));
  const sourceCodes = new Set(products.map(({ source }) => source.code));
  if (sourceCodes.size !== 1) throw new Error("One bootstrap run must contain products from one source");

  const reader = new WordPressProductSnapshotReader(wordpress);
  const exporter = new WordPressExporter(wordpress);
  const remote = await reader.read(products[0]!.source.code, products.map(({ sourceProduct }) => sourceProduct.externalId!));
  const remoteByExternalId = new Map(remote.map((item) => [item.sourceExternalId, item]));
  const reports: Record<string, unknown>[] = [];

  for (const { source, sourceProduct } of products) {
    const sourceExternalId = sourceProduct.externalId!;
    const item = remoteByExternalId.get(sourceExternalId);
    if (item === undefined || !item.found || item.externalId === undefined || item.snapshot === undefined) {
      reports.push({ sourceProductId: sourceProduct.id, sourceExternalId: sourceProduct.externalId, snapshot: "not_found", errorCode: item?.errorCode ?? null });
      continue;
    }
    await application.repositories.targets.saveProductSnapshot({
      targetId: target.id,
      sourceProductId: sourceProduct.id,
      externalId: item.externalId,
      sourceExternalId,
      payload: item.snapshot,
      contentHash: hashStableJson(item.snapshot),
      fetchedAt: new Date().toISOString(),
    });

    const internal = await application.repositories.internalProducts.findBySourceProductId(sourceProduct.id);
    if (internal === null) {
      reports.push({ sourceProductId: sourceProduct.id, sourceExternalId: sourceProduct.externalId, targetId: item.externalId, snapshot: "saved", dryRun: { status: "internal_product_missing" } });
      continue;
    }
    try {
      const payload = await buildWordPressUpsertPayload({
        source: { id: source.id, code: source.code, config: source.config },
        sourceProduct: {
          id: sourceProduct.id,
          sourceId: sourceProduct.sourceId,
          sourceKey: sourceProduct.sourceKey,
          externalId: sourceExternalId,
          ...(sourceProduct.slug === null ? {} : { slug: sourceProduct.slug }),
          ...(sourceProduct.url === null ? {} : { url: sourceProduct.url }),
          metadata: sourceProduct.discoveryMetadata,
        },
        target: { id: target.id, code: target.code, config: target.config },
        product: internal.data,
        existingExternalId: item.externalId,
        references: {
          resolveReference: (input) => application.targetMappings.resolveTargetValue(target.id, input.referenceId, input.targetScope),
          resolveProjections: (inputs) => application.targetMappings.resolveTargetProjections(target.id, inputs),
        },
      });
      const expectedItems = record(payload.variations).items;
      const actualItems = record(item.snapshot.product).variations;
      const expectedSizeTerms = variationSizeTerms(payload.variations, "payload");
      const actualSizeTerms = variationSizeTerms(actualItems, "snapshot");
      const preflight = await exporter.preflightPayload(payload);
      reports.push({
        sourceProductId: sourceProduct.id,
        sourceExternalId: sourceProduct.externalId,
        targetId: item.externalId,
        snapshot: "saved",
        dryRun: {
          status: "built",
          preflight,
          fieldDifferences: fieldDifferences(payload, item.snapshot),
          taxonomyDifferences: taxonomyDifferences(payload, item.snapshot),
          variations: {
            expected: Array.isArray(expectedItems) ? expectedItems.length : 0,
            actual: Array.isArray(actualItems) ? actualItems.length : 0,
            sizeTermsMatch: JSON.stringify(expectedSizeTerms) === JSON.stringify(actualSizeTerms),
            expectedSizeTerms,
            actualSizeTerms,
            differences: variationDifferences(preflight.variationPlan, actualItems),
          },
          images: {
            expected: Array.isArray(record(payload.product).images) ? (record(payload.product).images as readonly unknown[]).length : 0,
            actual: Array.isArray(record(item.snapshot.product).images) ? (record(item.snapshot.product).images as readonly unknown[]).length : 0,
          },
        },
      });
    } catch (error) {
      reports.push({ sourceProductId: sourceProduct.id, sourceExternalId: sourceProduct.externalId, targetId: item.externalId, snapshot: "saved", dryRun: { status: "blocked", error: error instanceof Error ? error.message : String(error) } });
    }
  }

  console.info(JSON.stringify({ targetId: target.id, products: reports }, null, 2));
} finally {
  await application.close();
}
