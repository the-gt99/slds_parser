import type { WordPressTargetConfig } from "../../config/index.js";
import type {
  ExportContext,
  ExportResult,
  JsonObject,
  JsonValue,
  ProductImageDTO,
  ProductSizeDTO,
  ProductVariantDTO,
  UniversalProductDTO,
} from "../../contracts/index.js";
import { IntegrationContractError, RetryableError } from "../../core/errors/index.js";
import { hashStableJson } from "../../core/utils/index.js";
import { WordPressSizeConverter, type WordPressSizeConverterLike } from "./wordpress-size-converter.js";
import {
  DEFAULT_WORDPRESS_DESCRIPTION_TEMPLATE,
  renderWordPressContentTemplate,
  type WordPressContentTemplateDefinition,
} from "./wordpress-content-template.js";

const CONTRACT_VERSION = "slds.wordpress.product-upsert.v1";

const REFERENCE_TARGETS = {
  brand: { scope: "product.brand", taxonomy: "pa_brand", cardinality: "single" },
  model: { scope: "product.model", taxonomy: "pa_model", cardinality: "single" },
  category: { scope: "product.category", taxonomy: "product_cat", cardinality: "multiple" },
  tag: { scope: "product.tag", taxonomy: "product_tag", cardinality: "multiple" },
  color: { scope: "product.color", taxonomy: "pa_tsvet", cardinality: "single" },
  material: { scope: "product.material", taxonomy: "pa_material", cardinality: "multiple" },
  activity: { scope: "product.activity", taxonomy: "pa_vid", cardinality: "multiple" },
  shoe_height: { scope: "product.shoe_height", taxonomy: "pa_shoe_height", cardinality: "single" },
  season: { scope: "product.season", taxonomy: "pa_season", cardinality: "single" },
} as const;

type ReferenceType = keyof typeof REFERENCE_TARGETS;

interface SizeMapping {
  readonly sourceValue: string;
  readonly displayValue?: string;
  readonly system?: string;
  readonly audience?: ProductSizeDTO["audience"];
  readonly taxonomy: string;
  readonly termId: number;
}

interface WordPressJob {
  readonly job_id?: unknown;
  readonly status?: unknown;
  readonly current_step?: unknown;
  readonly last_error?: unknown;
  readonly payload_hash?: unknown;
  readonly result?: unknown;
}

interface WordPressResponse {
  readonly ok?: unknown;
  readonly error?: unknown;
  readonly code?: unknown;
  readonly job?: unknown;
  readonly target_id?: unknown;
  readonly product_id?: unknown;
  readonly matched_by?: unknown;
  readonly payload_hash?: unknown;
  readonly variation_plan?: unknown;
}

export interface WordPressUpsertPreflightResult {
  readonly externalId: string | null;
  readonly willCreate: boolean;
  readonly matchedBy: string;
  readonly payloadHash: string;
  readonly variationPlan: readonly JsonObject[];
}

export interface WordPressUpsertPayloadPreview {
  readonly payload: JsonObject;
  readonly missingRequiredReferences: readonly string[];
  readonly contentContext: JsonObject;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new IntegrationContractError(`${label} must be a positive integer`);
  return parsed;
}

function requiredReferenceTypes(config: JsonObject): readonly ReferenceType[] {
  if (!Array.isArray(config.requiredReferenceTypes) || config.requiredReferenceTypes.length === 0) {
    throw new IntegrationContractError("target.config.requiredReferenceTypes must be a non-empty list");
  }
  const result = config.requiredReferenceTypes.map((value) => text(value));
  const unknown = result.filter((value) => !(value in REFERENCE_TARGETS));
  if (unknown.length > 0) throw new IntegrationContractError(`Unsupported required reference types: ${unknown.join(", ")}`);
  return [...new Set(result)] as readonly ReferenceType[];
}

function sizeMappings(config: JsonObject): readonly SizeMapping[] {
  if (!Array.isArray(config.sizeMappings) || config.sizeMappings.length === 0) {
    throw new IntegrationContractError("target.config.sizeMappings must be a non-empty list");
  }
  return config.sizeMappings.map((value, index) => {
    const row = record(value, `target.config.sizeMappings[${index}]`);
    const sourceValue = text(row.sourceValue);
    const displayValue = text(row.displayValue);
    const system = text(row.system).toLocaleLowerCase("en-US");
    const audience = text(row.audience).toLocaleLowerCase("en-US");
    const taxonomy = text(row.taxonomy);
    if (sourceValue === "") throw new IntegrationContractError(`target.config.sizeMappings[${index}].sourceValue is required`);
    if (!/^pa_[a-z0-9_-]+$/u.test(taxonomy)) throw new IntegrationContractError(`target.config.sizeMappings[${index}].taxonomy is invalid`);
    if (audience !== "" && !["men", "women", "youth", "infant", "unisex"].includes(audience)) {
      throw new IntegrationContractError(`target.config.sizeMappings[${index}].audience is invalid`);
    }
    return {
      sourceValue,
      ...(displayValue === "" ? {} : { displayValue }),
      ...(system === "" ? {} : { system }),
      ...(audience === "" ? {} : { audience: audience as NonNullable<ProductSizeDTO["audience"]> }),
      taxonomy,
      termId: positiveInteger(row.termId, `target.config.sizeMappings[${index}].termId`),
    };
  });
}

function mappingMatches(mapping: SizeMapping, size: ProductSizeDTO): boolean {
  return mapping.sourceValue === size.sourceValue
    && (mapping.displayValue === undefined || mapping.displayValue === size.displayValue)
    && (mapping.system === undefined || mapping.system === size.system)
    && (mapping.audience === undefined || mapping.audience === size.audience);
}

function findSizeMapping(size: ProductSizeDTO, mappings: readonly SizeMapping[]): SizeMapping | null {
  const matches = mappings.filter((mapping) => mappingMatches(mapping, size));
  const key = [size.system ?? "", size.audience ?? "", size.sourceValue, size.displayValue].join("/");
  if (matches.length === 0) return null;
  const specificity = (mapping: SizeMapping): number => [mapping.displayValue, mapping.system, mapping.audience]
    .filter((value) => value !== undefined).length;
  const mostSpecific = Math.max(...matches.map(specificity));
  const winners = matches.filter((mapping) => specificity(mapping) === mostSpecific);
  if (winners.length > 1) throw new IntegrationContractError(`WordPress size mapping is ambiguous: ${key}`);
  return winners[0]!;
}

function resolveSize(size: ProductSizeDTO, mappings: readonly SizeMapping[]): SizeMapping {
  const mapping = findSizeMapping(size, mappings);
  if (mapping !== null) return mapping;
  const key = [size.system ?? "", size.audience ?? "", size.sourceValue, size.displayValue].join("/");
  throw new IntegrationContractError(`WordPress size mapping is missing: ${key}`);
}

function mappedTargetScope(config: JsonObject, defaultScope: string): string {
  const configured = config.targetScopeMap;
  if (configured === null || typeof configured !== "object" || Array.isArray(configured)) return defaultScope;
  return text((configured as JsonObject)[defaultScope]) || defaultScope;
}

function targetForScope(config: JsonObject, scope: string): (typeof REFERENCE_TARGETS)[ReferenceType] | null {
  const matches = Object.values(REFERENCE_TARGETS).filter((target) => mappedTargetScope(config, target.scope) === scope);
  if (matches.length > 1) throw new IntegrationContractError(`WordPress target scope is ambiguous: ${scope}`);
  return matches[0] ?? null;
}

export function applyWordPressTitlePolicy(title: string, taxonomies: JsonObject, config: JsonObject): string {
  const rawPolicy = config.titlePrefixByCategoryTermId;
  if (rawPolicy === null || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) return title;
  const category = taxonomies.product_cat;
  if (category === null || typeof category !== "object" || Array.isArray(category)) return title;
  const termIds = (category as JsonObject).term_ids;
  if (!Array.isArray(termIds)) return title;
  const prefixes = [...new Set(termIds.map((termId) => text((rawPolicy as JsonObject)[String(termId)])).filter(Boolean))];
  if (prefixes.length === 0) return title;
  if (prefixes.length > 1) throw new IntegrationContractError("WordPress product categories resolve to different title prefixes");
  const prefix = prefixes[0]!;
  return title.toLocaleLowerCase("ru-RU").startsWith(prefix.toLocaleLowerCase("ru-RU")) ? title : `${prefix} ${title}`;
}

function moneyToMinorUnits(amount: string): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u.exec(amount.trim());
  if (match === null) throw new IntegrationContractError(`Unsupported money amount: ${amount}`);
  const whole = match[1]!;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const minor = `${whole}${fraction}`.replace(/^0+(?=\d)/u, "");
  if (minor === "0") throw new IntegrationContractError("WordPress variation price must be positive");
  return minor;
}

function imageFilename(image: ProductImageDTO, externalId: string): string {
  try {
    const name = new URL(image.url).pathname.split("/").at(-1)?.trim() ?? "";
    if (/^[^/]+\.(?:webp|png|jpe?g|gif)$/iu.test(name)) return name;
  } catch {
    // URL validity is reported by imagePayload.
  }
  return `${externalId}-${image.position + 1}.webp`;
}

function imagePayload(image: ProductImageDTO, externalId: string): JsonObject {
  let url: URL;
  try {
    url = new URL(image.url);
  } catch (cause) {
    throw new IntegrationContractError(`Product image URL is invalid: ${image.url}`, { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new IntegrationContractError(`Product image URL must use HTTP or HTTPS: ${image.url}`);
  }
  return {
    url: url.toString(),
    filename: imageFilename(image, externalId),
    ...(image.sourceUrl === undefined ? {} : { source_url: image.sourceUrl }),
    ...(image.sourceContentHash === undefined ? {} : { source_content_hash: image.sourceContentHash }),
    ...(image.contentHash === undefined ? {} : { content_hash: image.contentHash }),
    ...(image.perceptualHash === undefined ? {} : { perceptual_hash: image.perceptualHash }),
  };
}

function releaseDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/u.exec(value.trim());
  if (match === null) return value.trim();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return value.trim();
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  return `${String(day).padStart(2, "0")} ${months[month - 1]!} ${year}г.`;
}

function taxonomyTermIds(taxonomies: JsonObject, taxonomy: string): readonly number[] {
  const value = taxonomies[taxonomy];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const termIds = (value as JsonObject).term_ids;
  return Array.isArray(termIds)
    ? termIds.map(Number).filter((termId) => Number.isSafeInteger(termId) && termId > 0)
    : [];
}

function configuredConversionCategoryIds(config: JsonObject): readonly number[] {
  if (Array.isArray(config.sizeConversionCategoryTermIds)) {
    return config.sizeConversionCategoryTermIds.map((value, index) => positiveInteger(value, `target.config.sizeConversionCategoryTermIds[${index}]`));
  }
  const titlePolicy = config.titlePrefixByCategoryTermId;
  if (titlePolicy === null || typeof titlePolicy !== "object" || Array.isArray(titlePolicy)) return [];
  return Object.keys(titlePolicy).filter((value) => /^\d+$/u.test(value)).map(Number);
}

function sizeConversionIdentity(taxonomies: JsonObject, config: JsonObject): { readonly brandTermId: number; readonly categoryTermId: number } {
  const brandIds = taxonomyTermIds(taxonomies, "pa_brand");
  if (brandIds.length !== 1) {
    throw new IntegrationContractError("WordPress size conversion requires exactly one resolved pa_brand term");
  }
  const productCategoryIds = taxonomyTermIds(taxonomies, "product_cat");
  const configured = new Set(configuredConversionCategoryIds(config));
  const candidates = configured.size === 0 ? productCategoryIds : productCategoryIds.filter((termId) => configured.has(termId));
  if (candidates.length !== 1) {
    throw new IntegrationContractError("WordPress size conversion requires exactly one configured product_cat term");
  }
  return { brandTermId: brandIds[0]!, categoryTermId: candidates[0]! };
}

async function resolveVariationSize(
  size: ProductSizeDTO,
  mappings: readonly SizeMapping[],
  converter: WordPressSizeConverterLike | undefined,
  identity: { readonly brandTermId: number; readonly categoryTermId: number } | undefined,
): Promise<{ readonly mapping: SizeMapping; readonly size: ProductSizeDTO }> {
  const direct = findSizeMapping(size, mappings);
  if (direct !== null) return { mapping: direct, size };
  if (converter === undefined || !converter.supports(size) || identity === undefined) return { mapping: resolveSize(size, mappings), size };
  const converted = await converter.convert({ ...identity, size });
  const convertedMapping = findSizeMapping(converted, mappings);
  if (convertedMapping !== null) return { mapping: convertedMapping, size: converted };
  const sourceKey = [size.system ?? "", size.audience ?? "", size.sourceValue].join("/");
  const targetKey = [converted.system ?? "", converted.audience ?? "", converted.sourceValue].join("/");
  throw new IntegrationContractError(`WordPress size mapping is missing after conversion: ${sourceKey} -> ${targetKey}`);
}

async function variationPayload(
  variant: ProductVariantDTO,
  identityKey: string,
  mappings: readonly SizeMapping[],
  converter: WordPressSizeConverterLike | undefined,
  conversionIdentity: { readonly brandTermId: number; readonly categoryTermId: number } | undefined,
): Promise<{ readonly payload: JsonObject; readonly size: ProductSizeDTO; readonly availability: ProductVariantDTO["inventory"]["availability"] }> {
  const resolvedSize = await resolveVariationSize(variant.size, mappings, converter, conversionIdentity);
  if (variant.inventory.availability !== "available" && variant.inventory.availability !== "unavailable") {
    throw new IntegrationContractError(`Unsupported WordPress availability for variant ${variant.sourceVariantKey}: ${variant.inventory.availability}`);
  }
  const price = variant.price === null ? null : (() => {
    if (variant.price.currency.toUpperCase() !== "USD") {
      throw new IntegrationContractError(`WordPress pricing supports USD only: ${variant.price.currency}`);
    }
    return { source_currency: "USD", source_minor_amount: moneyToMinorUnits(variant.price.amount) } as const;
  })();
  if (variant.inventory.availability === "available" && price === null) {
    throw new IntegrationContractError(`Available WordPress variation has no price: ${variant.sourceVariantKey}`);
  }
  return { payload: {
    variation_key: `${identityKey}|${variant.sourceVariantKey}`,
    source_variant_key: variant.sourceVariantKey,
    sku: variant.sku,
    size: { taxonomy: resolvedSize.mapping.taxonomy, term_id: resolvedSize.mapping.termId },
    price,
    inventory: {
      availability: variant.inventory.availability,
      ...(variant.inventory.quantity === undefined ? {} : { quantity: variant.inventory.quantity }),
    },
  }, size: resolvedSize.size, availability: variant.inventory.availability };
}

function classifiedValues(product: UniversalProductDTO, typeCode: string): readonly string[] {
  const resolved = new Set(product.classification?.resolved.filter((item) => item.typeCode === typeCode).map((item) => item.candidateKey) ?? []);
  return [...new Set(product.referenceCandidates
    .filter((candidate) => candidate.typeCode === typeCode && resolved.has(candidate.key))
    .map((candidate) => candidate.sourceValue.trim())
    .filter(Boolean))];
}

function singleValue(values: readonly (string | undefined)[]): string {
  const unique = [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
  return unique.length === 1 ? unique[0]! : "";
}

function wordpressContentContext(
  product: UniversalProductDTO,
  effectiveTitle: string,
  variations: readonly { readonly size: ProductSizeDTO; readonly availability: ProductVariantDTO["inventory"]["availability"] }[],
): JsonObject {
  const translated = product.translatedContent;
  const allSizes = variations.map((variation) => variation.size.displayValue || variation.size.sourceValue);
  const availableSizes = variations.filter((variation) => variation.availability === "available")
    .map((variation) => variation.size.displayValue || variation.size.sourceValue);
  return {
    product: { effective_title: effectiveTitle, source_title: product.title, sku: product.sku },
    content: {
      story: translated?.story || translated?.description || product.description,
      description: translated?.description || product.description,
      color: translated?.color || text(product.attributes.color),
      details: translated?.details || text(product.attributes.details),
      upper_material: translated?.upperMaterial || text(product.attributes.upperMaterial),
    },
    attributes: {
      midsole: text(product.attributes.midsole),
      category: text(product.attributes.categoryRaw),
      release_date: releaseDate(text(product.attributes.releaseDate)),
    },
    classification: {
      brands: classifiedValues(product, "brand"),
      models: classifiedValues(product, "model"),
      categories: classifiedValues(product, "category"),
      tags: classifiedValues(product, "tag"),
      colors: classifiedValues(product, "color"),
      materials: classifiedValues(product, "material"),
    },
    variants: {
      available_sizes: availableSizes,
      all_sizes: allSizes,
      audience: singleValue(variations.map((variation) => variation.size.audience)),
      size_system: singleValue(variations.map((variation) => variation.size.system)),
      available_count: variations.filter((variation) => variation.availability === "available").length,
      count: variations.length,
    },
  };
}

function templateByField(templates: readonly WordPressContentTemplateDefinition[], field: WordPressContentTemplateDefinition["field"]): WordPressContentTemplateDefinition | null {
  const matches = templates.filter((template) => template.field === field);
  if (matches.length > 1) throw new IntegrationContractError(`More than one active WordPress ${field} template is configured`);
  return matches[0] ?? null;
}

export function renderWordPressContentFields(
  context: JsonObject,
  templates: readonly WordPressContentTemplateDefinition[] = [],
): { readonly descriptionHtml: string; readonly shortDescriptionHtml?: string } {
  const description = templateByField(templates, "description");
  const shortDescription = templateByField(templates, "short_description");
  return {
    descriptionHtml: renderWordPressContentTemplate(description?.templateSource ?? DEFAULT_WORDPRESS_DESCRIPTION_TEMPLATE, context),
    ...(shortDescription === null ? {} : { shortDescriptionHtml: renderWordPressContentTemplate(shortDescription.templateSource, context) }),
  };
}

async function taxonomyPayload(
  context: ExportContext,
  required: readonly ReferenceType[],
  allowMissingRequired: boolean,
): Promise<{ readonly taxonomies: JsonObject; readonly missingRequired: readonly ReferenceType[] }> {
  if (context.product.classification === undefined) throw new IntegrationContractError("Product classification is required before WordPress export");
  const unresolvedKeys = new Set(context.product.classification.unresolved.map((reference) => reference.candidateKey));
  const grouped = new Map<string, Set<number>>();
  for (const candidate of context.product.referenceCandidates) {
    if (candidate.subjectKind !== "product" || !(candidate.typeCode in REFERENCE_TARGETS) || unresolvedKeys.has(candidate.key)) continue;
    const target = REFERENCE_TARGETS[candidate.typeCode as ReferenceType];
    if (!grouped.has(target.taxonomy)) grouped.set(target.taxonomy, new Set<number>());
  }
  const presentTypes = new Set<ReferenceType>();
  const termsByType = new Map<ReferenceType, Set<number>>();
  for (const reference of context.product.classification.resolved) {
    if (!(reference.typeCode in REFERENCE_TARGETS)) continue;
    if (reference.subjectKind !== "product") throw new IntegrationContractError(`WordPress does not support variant reference ${reference.candidateKey}`);
    const type = reference.typeCode as ReferenceType;
    const target = REFERENCE_TARGETS[type];
    const externalId = await context.references.resolveReference({
      referenceId: reference.referenceValueId,
      referenceType: type,
      targetScope: mappedTargetScope(context.target.config, target.scope),
    });
    const termId = positiveInteger(externalId, `WordPress mapping ${type}/${reference.referenceValueId}`);
    const values = grouped.get(target.taxonomy) ?? new Set<number>();
    values.add(termId);
    grouped.set(target.taxonomy, values);
    const typeTerms = termsByType.get(type) ?? new Set<number>();
    typeTerms.add(termId);
    termsByType.set(type, typeTerms);
    presentTypes.add(type);
  }
  const projections = await context.references.resolveProjections(
    context.product.classification.resolved.map((reference) => ({
      resolutionKind: reference.resolutionKind,
      resolutionId: reference.resolutionId,
    })),
  );
  for (const projection of projections) {
    const target = targetForScope(context.target.config, projection.targetScope);
    if (target === null) throw new IntegrationContractError(`WordPress projection has an unsupported target scope: ${projection.targetScope}`);
    const termId = positiveInteger(projection.externalValue, `WordPress projection ${projection.resolutionKind}/${projection.resolutionId}`);
    const values = grouped.get(target.taxonomy) ?? new Set<number>();
    values.add(termId);
    grouped.set(target.taxonomy, values);
  }
  const invalidSingleTypes = [...termsByType.entries()]
    .filter(([type, termIds]) => REFERENCE_TARGETS[type].cardinality === "single" && termIds.size > 1)
    .map(([type]) => type);
  if (invalidSingleTypes.length > 0) {
    throw new IntegrationContractError(`WordPress single-value references contain multiple terms: ${invalidSingleTypes.join(", ")}`);
  }
  const missing = required.filter((type) => !presentTypes.has(type));
  if (!allowMissingRequired && missing.length > 0) {
    throw new IntegrationContractError(`Required WordPress references are missing: ${missing.join(", ")}`);
  }
  return {
    taxonomies: Object.fromEntries([...grouped.entries()].map(([taxonomy, termIds]) => [taxonomy, { mode: "replace", term_ids: [...termIds] }])),
    missingRequired: missing,
  };
}

async function buildWordPressPayload(
  context: ExportContext,
  allowMissingRequired: boolean,
  converter?: WordPressSizeConverterLike,
): Promise<WordPressUpsertPayloadPreview> {
  const sourceExternalId = context.sourceProduct.externalId?.trim() ?? "";
  if (sourceExternalId === "") throw new IntegrationContractError("Source product externalId is required for WordPress export");
  if (context.product.images.length === 0) {
    throw new IntegrationContractError("WordPress export requires at least one processed product image");
  }
  if (context.product.variants.length === 0) {
    throw new IntegrationContractError("WordPress export requires product variants until the sold-out contract is configured");
  }
  const sourceCode = context.source.code.trim().toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(sourceCode)) throw new IntegrationContractError(`Source code cannot be used in WordPress identity: ${context.source.code}`);
  const externalKey = `${sourceCode}:${sourceExternalId}`;
  const required = requiredReferenceTypes(context.target.config);
  const mappings = sizeMappings(context.target.config);
  const { taxonomies, missingRequired } = await taxonomyPayload(context, required, allowMissingRequired);
  const needsConversion = converter !== undefined && context.product.variants.some(
    (variant) => findSizeMapping(variant.size, mappings) === null && converter.supports(variant.size),
  );
  const conversionIdentity = needsConversion && converter !== undefined
    ? sizeConversionIdentity(taxonomies, context.target.config)
    : undefined;
  const resolvedVariations = await Promise.all(context.product.variants.map(
    (variant) => variationPayload(variant, externalKey, mappings, converter, conversionIdentity),
  ));
  const variations = resolvedVariations.map((variation) => variation.payload);
  const targetSizes = new Set(variations.map((variation) => {
    const size = variation.size as JsonObject;
    return `${String(size.taxonomy)}:${String(size.term_id)}`;
  }));
  if (targetSizes.size !== variations.length) throw new IntegrationContractError("More than one product variant resolves to the same WordPress size");
  const targetId = context.existingExternalId === undefined ? 0 : positiveInteger(context.existingExternalId, "existingExternalId");
  const title = applyWordPressTitlePolicy(context.product.title, taxonomies, context.target.config);
  const contentContext = wordpressContentContext(context.product, title, resolvedVariations);
  const contentTemplates = context.contentTemplates ?? [];
  const content = renderWordPressContentFields(contentContext, contentTemplates);
  const managedFields = ["title", "slug", "sku", "description", "images", "taxonomies", "variations"];
  if (content.shortDescriptionHtml !== undefined) managedFields.push("short_description");
  const base: JsonObject = {
    contract_version: CONTRACT_VERSION,
    mode: "upsert",
    identity: {
      source_code: sourceCode,
      source_external_id: sourceExternalId,
      external_key: externalKey,
      target_id: targetId,
    },
    managed_fields: managedFields,
    product: {
      title,
      slug: context.sourceProduct.slug ?? "",
      sku: context.product.sku,
      description_html: content.descriptionHtml,
      ...(content.shortDescriptionHtml === undefined ? {} : { short_description_html: content.shortDescriptionHtml }),
      status: "publish",
      images: context.product.images.map((image) => imagePayload(image, sourceExternalId)),
      taxonomies,
    },
    variations: { mode: "replace_active_set", missing_policy: "out_of_stock", items: variations },
  };
  const idempotencyKey = `product-upsert:${hashStableJson(base)}`;
  const payload = { ...base, idempotency_key: idempotencyKey } satisfies JsonObject;
  return {
    payload: { ...payload, payload_hash: hashStableJson(payload) },
    missingRequiredReferences: missingRequired,
    contentContext,
  };
}

export async function previewWordPressUpsertPayload(
  context: ExportContext,
  converter?: WordPressSizeConverterLike,
): Promise<WordPressUpsertPayloadPreview> {
  return buildWordPressPayload(context, true, converter);
}

export async function buildWordPressUpsertPayload(
  context: ExportContext,
  converter?: WordPressSizeConverterLike,
): Promise<JsonObject> {
  return (await buildWordPressPayload(context, false, converter)).payload;
}

function normalizeJob(value: unknown): WordPressJob {
  return record(value, "WordPress job") as WordPressJob;
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class WordPressExporter {
  readonly targetCode = "wordpress";
  readonly version = "1.4.0";
  private readonly sizeConverter: WordPressSizeConverterLike;

  constructor(
    private readonly config: WordPressTargetConfig,
    private readonly requestImplementation: typeof fetch = fetch,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.sizeConverter = new WordPressSizeConverter(config, requestImplementation);
  }

  async previewPayload(context: ExportContext): Promise<WordPressUpsertPayloadPreview> {
    return previewWordPressUpsertPayload(context, this.sizeConverter);
  }

  async buildPayload(context: ExportContext): Promise<JsonObject> {
    return buildWordPressUpsertPayload(context, this.sizeConverter);
  }

  async preflightPayload(payload: JsonObject): Promise<WordPressUpsertPreflightResult> {
    const expectedPayloadHash = text(payload.payload_hash);
    if (!/^[a-f0-9]{64}$/u.test(expectedPayloadHash)) throw new IntegrationContractError("WordPress preflight payload_hash is invalid");
    const response = await this.request("upsert-lookup", { method: "POST", body: JSON.stringify({ payload }) });
    const matchedBy = text(response.matched_by);
    if (matchedBy === "") throw new IntegrationContractError("WordPress preflight matched_by is required");
    const rawTargetId = response.target_id ?? response.product_id;
    const targetId = typeof rawTargetId === "number"
      ? rawTargetId
      : typeof rawTargetId === "string" && /^\d+$/u.test(rawTargetId) ? Number(rawTargetId) : Number.NaN;
    if (!Number.isSafeInteger(targetId) || targetId < 0) {
      throw new IntegrationContractError("WordPress preflight target_id must be a non-negative integer");
    }
    const willCreate = targetId === 0;
    if (willCreate !== (matchedBy === "created")) {
      throw new IntegrationContractError("WordPress preflight target_id does not match matched_by");
    }
    const externalId = willCreate ? null : String(targetId);
    const payloadHash = text(response.payload_hash);
    if (payloadHash !== expectedPayloadHash) throw new IntegrationContractError("WordPress preflight payload hash does not match the request");
    if (!Array.isArray(response.variation_plan)) throw new IntegrationContractError("WordPress preflight variation_plan must be a list");
    const variationPlan = response.variation_plan.map((value, index) => record(value, `WordPress preflight variation_plan[${index}]`) as JsonObject);
    return { externalId, willCreate, matchedBy, payloadHash, variationPlan };
  }

  async export(context: ExportContext): Promise<ExportResult> {
    const payload = await this.buildPayload(context);
    const expectedPayloadHash = text(payload.payload_hash);
    const created = await this.request("upsert-jobs", { method: "POST", body: JSON.stringify({ payload }) });
    const initialJob = normalizeJob(created.job);
    const jobId = positiveInteger(initialJob.job_id, "WordPress job_id");
    const job = await this.waitForJob(jobId, expectedPayloadHash, initialJob);
    const result = record(job.result, "WordPress job result");
    const externalId = String(positiveInteger(result.target_id ?? result.product_id, "WordPress target_id"));
    const operation = result.operation === "created" ? "created" : result.operation === "updated" ? "updated" : null;
    if (operation === null) throw new IntegrationContractError("WordPress job result has an unsupported operation");
    return {
      externalId,
      operation,
      metadata: {
        jobId,
        payloadHash: text(job.payload_hash),
        matchedBy: text(result.matched_by),
      },
    };
  }

  private async waitForJob(jobId: number, expectedPayloadHash: string, initialJob: WordPressJob): Promise<WordPressJob> {
    const deadline = Date.now() + this.config.jobTimeoutMs;
    let job = initialJob;
    while (true) {
      if (positiveInteger(job.job_id, "WordPress job_id") !== jobId) {
        throw new IntegrationContractError(`WordPress returned a different job while waiting for ${jobId}`);
      }
      if (text(job.payload_hash) !== expectedPayloadHash) {
        throw new IntegrationContractError(`WordPress job ${jobId} payload hash does not match the export request`);
      }
      const status = text(job.status);
      if (status === "done") return job;
      if (status === "error") {
        throw new IntegrationContractError(`WordPress upsert job failed at ${text(job.current_step) || "unknown"}: ${text(job.last_error) || "unknown error"}`);
      }
      if (status !== "pending" && status !== "processing") throw new IntegrationContractError(`WordPress returned an unsupported job status: ${status}`);
      if (Date.now() >= deadline) throw new RetryableError(`WordPress upsert job timed out: ${jobId}`, { code: "WORDPRESS_JOB_TIMEOUT" });
      await this.wait(this.config.pollIntervalMs);
      const response = await this.request("job", { method: "GET" }, { id: String(jobId) });
      job = normalizeJob(response.job);
    }
  }

  private async request(action: string, init: RequestInit, query: Readonly<Record<string, string>> = {}): Promise<WordPressResponse> {
    const url = new URL(`${this.config.baseUrl}/`);
    url.searchParams.set("slds_target_import_api", action);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.requestImplementation(url, {
        ...init,
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "SLDS-Parser/wordpress-exporter",
          "X-SLDS-Import-Token": this.config.authToken,
          Authorization: `Bearer ${this.config.authToken}`,
          ...init.headers,
        },
      });
    } catch (cause) {
      throw new RetryableError("WordPress export request failed", { code: "WORDPRESS_EXPORT_REQUEST_FAILED", cause });
    }
    const body = await response.text();
    let decoded: WordPressResponse;
    try {
      decoded = JSON.parse(body.replace(/^\uFEFF/u, "")) as WordPressResponse;
    } catch (cause) {
      if (retryableHttpStatus(response.status)) {
        throw new RetryableError(`WordPress exporter returned invalid JSON with HTTP ${response.status}`, { code: "WORDPRESS_EXPORT_INVALID_RESPONSE", cause });
      }
      throw new IntegrationContractError(`WordPress exporter returned invalid JSON with HTTP ${response.status}`, { cause });
    }
    if (!response.ok || decoded.ok !== true) {
      const message = text(decoded.error) || text(decoded.code) || `HTTP ${response.status}`;
      if (retryableHttpStatus(response.status)) throw new RetryableError(`WordPress exporter request failed: ${message}`, { code: "WORDPRESS_EXPORT_HTTP_ERROR" });
      throw new IntegrationContractError(`WordPress exporter request failed: ${message}`);
    }
    return decoded;
  }
}

export { CONTRACT_VERSION as WORDPRESS_PRODUCT_UPSERT_CONTRACT };
