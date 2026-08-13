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
  WORDPRESS_EXISTING_STORY_MARKER,
  contentTemplateContextValuePresent,
  contentTemplateContextWithExistingStoryPlaceholder,
  renderWordPressContentTemplate,
  selectWordPressContentTemplate,
  type WordPressContentTemplateDefinition,
  type WordPressContentTemplateSelection,
} from "./wordpress-content-template.js";

const CONTRACT_VERSION = "slds.wordpress.product-upsert.v1";

const REFERENCE_TARGETS = {
  brand: { scope: "product.brand", taxonomy: "pa_brand", cardinality: "multiple" },
  model: { scope: "product.model", taxonomy: "pa_model", cardinality: "multiple" },
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
  readonly snapshot?: unknown;
  readonly resolved_content?: unknown;
}

export interface WordPressUpsertPreflightResult {
  readonly externalId: string | null;
  readonly willCreate: boolean;
  readonly matchedBy: string;
  readonly payloadHash: string;
  readonly variationPlan: readonly JsonObject[];
  readonly snapshot?: JsonObject;
  readonly resolvedDescriptionHtml?: string;
  readonly resolvedStorySource?: "wordpress_existing" | "empty";
}

export interface WordPressUpsertPayloadPreview {
  readonly payload: JsonObject;
  readonly missingRequiredReferences: readonly string[];
  readonly ignoredSizeVariants: readonly {
    readonly sourceVariantKey: string;
    readonly sku: string;
    readonly sourceValue: string;
    readonly displayValue: string;
    readonly system: string | null;
    readonly audience: ProductSizeDTO["audience"] | null;
    readonly price: JsonObject | null;
    readonly reason: string;
  }[];
  readonly contentContext: JsonObject;
  readonly contentTemplateSelections: Readonly<Record<WordPressContentTemplateDefinition["field"], WordPressContentTemplateSelection>>;
  readonly taxonomyOrigins: readonly {
    readonly taxonomy: string;
    readonly termId: number;
    readonly relationCode: string;
    readonly sourceTypeCode: string;
    readonly sourceLabel: string;
  }[];
}

type WordPressTaxonomyOrigin = WordPressUpsertPayloadPreview["taxonomyOrigins"][number];

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

function ignoreUnmappedSizeVariants(config: JsonObject): boolean {
  const value = config.ignoreUnmappedSizeVariants;
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new IntegrationContractError("target.config.ignoreUnmappedSizeVariants must be a boolean");
  }
  return value;
}

function isMissingSizeMappingError(error: unknown): error is IntegrationContractError {
  return error instanceof IntegrationContractError
    && (error.message.startsWith("WordPress size mapping is missing:")
      || error.message.startsWith("WordPress size mapping is missing after conversion:"));
}

function ignoredSizeVariant(
  variant: ProductVariantDTO,
  reason: string,
): WordPressUpsertPayloadPreview["ignoredSizeVariants"][number] {
  return {
    sourceVariantKey: variant.sourceVariantKey,
    sku: variant.sku,
    sourceValue: variant.size.sourceValue,
    displayValue: variant.size.displayValue,
    system: variant.size.system ?? null,
    audience: variant.size.audience ?? null,
    price: variant.price === null ? null : { amount: variant.price.amount, currency: variant.price.currency },
    reason,
  };
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

function sizeConversionIdentity(
  taxonomies: JsonObject,
  config: JsonObject,
  primaryBrandTermId: number | null,
): { readonly brandTermId: number; readonly categoryTermId: number } {
  if (primaryBrandTermId === null) {
    throw new IntegrationContractError("WordPress size conversion requires exactly one primary resolved pa_brand term");
  }
  const productCategoryIds = taxonomyTermIds(taxonomies, "product_cat");
  const configured = new Set(configuredConversionCategoryIds(config));
  const candidates = configured.size === 0 ? productCategoryIds : productCategoryIds.filter((termId) => configured.has(termId));
  if (candidates.length !== 1) {
    throw new IntegrationContractError("WordPress size conversion requires exactly one configured product_cat term");
  }
  return { brandTermId: primaryBrandTermId, categoryTermId: candidates[0]! };
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

async function resolveVariationSet(
  variants: readonly ProductVariantDTO[],
  identityKey: string,
  mappings: readonly SizeMapping[],
  converter: WordPressSizeConverterLike | undefined,
  conversionIdentity: { readonly brandTermId: number; readonly categoryTermId: number } | undefined,
  ignoreMissingMappings: boolean,
): Promise<{
  readonly resolved: readonly Awaited<ReturnType<typeof variationPayload>>[];
  readonly ignored: WordPressUpsertPayloadPreview["ignoredSizeVariants"];
}> {
  const rows = await Promise.all(variants.map(async (variant) => {
    try {
      return { resolved: await variationPayload(variant, identityKey, mappings, converter, conversionIdentity), ignored: null };
    } catch (error) {
      if (!ignoreMissingMappings || !isMissingSizeMappingError(error)) throw error;
      return { resolved: null, ignored: ignoredSizeVariant(variant, error.message) };
    }
  }));
  return {
    resolved: rows.flatMap((row) => row.resolved === null ? [] : [row.resolved]),
    ignored: rows.flatMap((row) => row.ignored === null ? [] : [row.ignored]),
  };
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
  modelTagLink: { readonly name: string; readonly url: string } | null,
): JsonObject {
  const translated = product.translatedContent;
  const allSizes = variations.map((variation) => variation.size.displayValue || variation.size.sourceValue);
  const availableSizes = variations.filter((variation) => variation.availability === "available")
    .map((variation) => variation.size.displayValue || variation.size.sourceValue);
  return {
    product: { effective_title: effectiveTitle, source_title: product.title, sku: product.sku },
    content: {
      story: translated?.story || "",
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
    links: {
      model_tag_name: modelTagLink?.name ?? "",
      model_tag_url: modelTagLink?.url ?? "",
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

export function renderWordPressContentFields(
  context: JsonObject,
  templates: readonly WordPressContentTemplateDefinition[] = [],
  productCategoryTermIds: readonly number[] = [],
): {
  readonly descriptionHtml?: string;
  readonly shortDescriptionHtml?: string;
  readonly descriptionStoryPolicy?: { readonly mode: "preserve_existing"; readonly required: boolean };
  readonly selections: Readonly<Record<WordPressContentTemplateDefinition["field"], WordPressContentTemplateSelection>>;
} {
  const description = selectWordPressContentTemplate("description", templates, context, productCategoryTermIds);
  const shortDescription = selectWordPressContentTemplate("short_description", templates, context, productCategoryTermIds);
  const preserveExistingStory = description.managed && description.preserveExistingStory === true
    && !contentTemplateContextValuePresent(context, "content.story");
  const descriptionContext = preserveExistingStory ? contentTemplateContextWithExistingStoryPlaceholder(context) : context;
  const descriptionHtml = description.managed
    ? renderWordPressContentTemplate(description.templateSource ?? DEFAULT_WORDPRESS_DESCRIPTION_TEMPLATE, descriptionContext)
    : undefined;
  if (preserveExistingStory && (descriptionHtml?.split(WORDPRESS_EXISTING_STORY_MARKER).length ?? 0) !== 2) {
    throw new IntegrationContractError("Description template must render the WordPress story placeholder exactly once");
  }
  return {
    ...(descriptionHtml === undefined ? {} : { descriptionHtml }),
    ...(shortDescription.managed ? { shortDescriptionHtml: renderWordPressContentTemplate(shortDescription.templateSource!, context) } : {}),
    ...(preserveExistingStory ? { descriptionStoryPolicy: { mode: "preserve_existing" as const, required: description.requireStoryAfterFallback === true } } : {}),
    selections: { description, short_description: shortDescription },
  };
}

function preserveExistingBrandTerms(config: JsonObject): boolean {
  const value = config.preserveExistingBrandTerms;
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new IntegrationContractError("target.config.preserveExistingBrandTerms must be a boolean");
  }
  return value;
}

function snapshotTaxonomyTermIds(snapshot: JsonObject, taxonomy: string): readonly number[] {
  const product = record(snapshot.product, "WordPress target snapshot product");
  const taxonomies = record(product.taxonomies, "WordPress target snapshot product.taxonomies");
  const terms = taxonomies[taxonomy];
  if (terms === undefined) return [];
  if (!Array.isArray(terms)) {
    throw new IntegrationContractError(`WordPress target snapshot taxonomy ${taxonomy} must be a list`);
  }
  return [...new Set(terms.map((term, index) => positiveInteger(
    record(term, `WordPress target snapshot taxonomy ${taxonomy}[${index}]`).term_id,
    `WordPress target snapshot taxonomy ${taxonomy}[${index}].term_id`,
  )))];
}

function mergePreservedBrandTerms(context: ExportContext, taxonomies: JsonObject): JsonObject {
  if (!preserveExistingBrandTerms(context.target.config)) return taxonomies;
  if (context.existingTargetSnapshot === undefined) {
    if (context.existingExternalId === undefined) return taxonomies;
    throw new IntegrationContractError("WordPress target snapshot is required to preserve existing brand terms");
  }
  const existing = snapshotTaxonomyTermIds(context.existingTargetSnapshot, "pa_brand");
  if (existing.length === 0) return taxonomies;
  const resolved = taxonomyTermIds(taxonomies, "pa_brand");
  return {
    ...taxonomies,
    pa_brand: { mode: "replace", term_ids: [...new Set([...existing, ...resolved])] },
  };
}

async function taxonomyPayload(
  context: ExportContext,
  required: readonly ReferenceType[],
  allowMissingRequired: boolean,
): Promise<{
  readonly taxonomies: JsonObject;
  readonly missingRequired: readonly ReferenceType[];
  readonly taxonomyOrigins: readonly WordPressTaxonomyOrigin[];
  readonly modelTagLink: { readonly name: string; readonly url: string } | null;
  readonly primaryBrandTermId: number | null;
}> {
  if (context.product.classification === undefined) throw new IntegrationContractError("Product classification is required before WordPress export");
  const unresolvedKeys = new Set(context.product.classification.unresolved.map((reference) => reference.candidateKey));
  const grouped = new Map<string, Set<number>>();
  const taxonomyOrigins: WordPressTaxonomyOrigin[] = [];
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
      referenceId: reference.referenceValueId,
    })),
  );
  const modelTagLinks = new Map<string, { readonly name: string; readonly url: string }>();
  for (const projection of projections) {
    const target = targetForScope(context.target.config, projection.targetScope);
    if (target === null) throw new IntegrationContractError(`WordPress projection has an unsupported target scope: ${projection.targetScope}`);
    const termId = positiveInteger(projection.externalValue, `WordPress projection ${projection.resolutionKind}/${projection.resolutionId}`);
    const values = grouped.get(target.taxonomy) ?? new Set<number>();
    values.add(termId);
    grouped.set(target.taxonomy, values);
    if (projection.provenance !== undefined) {
      taxonomyOrigins.push({
        taxonomy: target.taxonomy,
        termId,
        relationCode: projection.provenance.relationCode,
        sourceTypeCode: projection.provenance.sourceTypeCode,
        sourceLabel: projection.provenance.sourceLabel,
      });
      const modelName = projection.provenance.sourceLabel.trim();
      const tagSlug = projection.externalSlug?.trim() ?? "";
      if (target.taxonomy === "product_tag"
        && projection.provenance.relationCode === "landing"
        && projection.provenance.sourceTypeCode === "model"
        && modelName !== ""
        && tagSlug !== "") {
        const link = { name: modelName, url: `/tags/${encodeURIComponent(tagSlug)}/` } as const;
        modelTagLinks.set(`${link.name}\u0000${link.url}`, link);
      }
    }
  }
  if (modelTagLinks.size > 1) {
    throw new IntegrationContractError("WordPress model resolves to more than one landing tag");
  }
  const assignments = await context.references.resolveAssignments(context.product);
  const replacementGroups = new Map<string, string>();
  const preparedAssignments: { readonly assignment: (typeof assignments)[number]; readonly taxonomy: string; readonly termId: number }[] = [];
  for (const assignment of assignments) {
    const target = targetForScope(context.target.config, assignment.targetScope);
    if (target === null) throw new IntegrationContractError(`WordPress assignment has an unsupported target scope: ${assignment.targetScope}`);
    const assignmentTypes = (Object.keys(REFERENCE_TARGETS) as ReferenceType[])
      .filter((type) => mappedTargetScope(context.target.config, REFERENCE_TARGETS[type].scope) === assignment.targetScope);
    if (assignmentTypes.length === 1) presentTypes.add(assignmentTypes[0]!);
    const termId = positiveInteger(assignment.externalValue, `WordPress assignment rule ${assignment.ruleId}`);
    preparedAssignments.push({ assignment, taxonomy: target.taxonomy, termId });
    if (assignment.mode === "replace") {
      const previousGroup = replacementGroups.get(target.taxonomy);
      if (previousGroup !== undefined && previousGroup !== assignment.groupCode) {
        throw new IntegrationContractError(`WordPress assignments replace ${target.taxonomy} from more than one rule group`);
      }
      replacementGroups.set(target.taxonomy, assignment.groupCode);
    }
  }
  for (const taxonomy of replacementGroups.keys()) grouped.set(taxonomy, new Set<number>());
  for (const { taxonomy, termId } of preparedAssignments) {
    const values = grouped.get(taxonomy) ?? new Set<number>();
    values.add(termId);
    grouped.set(taxonomy, values);
  }
  const invalidSingleTypes = [...termsByType.entries()]
    .filter(([type, termIds]) => REFERENCE_TARGETS[type].cardinality === "single" && termIds.size > 1)
    .map(([type]) => type);
  if (invalidSingleTypes.length > 0) {
    throw new IntegrationContractError(`WordPress single-value references contain multiple terms: ${invalidSingleTypes.join(", ")}`);
  }
  const invalidSingleAssignments = Object.values(REFERENCE_TARGETS)
    .filter((target) => target.cardinality === "single" && (grouped.get(target.taxonomy)?.size ?? 0) > 1)
    .map((target) => target.scope);
  if (invalidSingleAssignments.length > 0) {
    throw new IntegrationContractError(`WordPress single-value assignments contain multiple terms: ${invalidSingleAssignments.join(", ")}`);
  }
  const primaryBrandTerms = termsByType.get("brand") ?? new Set<number>();
  const missing = required.filter((type) => !presentTypes.has(type));
  if (!allowMissingRequired && missing.length > 0) {
    throw new IntegrationContractError(`Required WordPress references are missing: ${missing.join(", ")}`);
  }
  return {
    taxonomies: Object.fromEntries([...grouped.entries()].map(([taxonomy, termIds]) => [taxonomy, { mode: "replace", term_ids: [...termIds] }])),
    missingRequired: missing,
    taxonomyOrigins,
    modelTagLink: [...modelTagLinks.values()][0] ?? null,
    primaryBrandTermId: primaryBrandTerms.size === 1 ? [...primaryBrandTerms][0]! : null,
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
  const outputVariants = context.liveVariants ?? context.product.variants;
  if (outputVariants.length === 0) {
    throw new IntegrationContractError("WordPress export requires product variants until the sold-out contract is configured");
  }
  const sourceCode = context.source.code.trim().toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(sourceCode)) throw new IntegrationContractError(`Source code cannot be used in WordPress identity: ${context.source.code}`);
  const externalKey = `${sourceCode}:${sourceExternalId}`;
  const required = requiredReferenceTypes(context.target.config);
  const mappings = sizeMappings(context.target.config);
  const ignoreMissingSizeMappings = ignoreUnmappedSizeVariants(context.target.config);
  const taxonomyResult = await taxonomyPayload(context, required, allowMissingRequired);
  const { missingRequired, taxonomyOrigins, modelTagLink, primaryBrandTermId } = taxonomyResult;
  const taxonomies = mergePreservedBrandTerms(context, taxonomyResult.taxonomies);
  const variantsForConversion = context.liveVariants === undefined
    ? context.product.variants
    : [...context.product.variants, ...context.liveVariants];
  const needsConversion = converter !== undefined && variantsForConversion.some(
    (variant) => findSizeMapping(variant.size, mappings) === null && converter.supports(variant.size),
  );
  const conversionIdentity = needsConversion && converter !== undefined
    ? sizeConversionIdentity(taxonomies, context.target.config, primaryBrandTermId)
    : undefined;
  const outputResolution = await resolveVariationSet(
    outputVariants,
    externalKey,
    mappings,
    converter,
    conversionIdentity,
    ignoreMissingSizeMappings,
  );
  const resolvedVariations = outputResolution.resolved;
  if (resolvedVariations.length === 0) {
    throw new IntegrationContractError("WordPress export has no variants with mapped sizes");
  }
  const variations = resolvedVariations.map((variation) => variation.payload);
  const targetSizes = new Set(variations.map((variation) => {
    const size = variation.size as JsonObject;
    return `${String(size.taxonomy)}:${String(size.term_id)}`;
  }));
  if (targetSizes.size !== variations.length) throw new IntegrationContractError("More than one product variant resolves to the same WordPress size");
  const targetId = context.existingExternalId === undefined ? 0 : positiveInteger(context.existingExternalId, "existingExternalId");
  const title = applyWordPressTitlePolicy(context.product.title, taxonomies, context.target.config);
  const contentResolution = context.liveVariants === undefined
    ? outputResolution
    : await resolveVariationSet(
      context.product.variants,
      externalKey,
      mappings,
      converter,
      conversionIdentity,
      ignoreMissingSizeMappings,
    );
  const contentVariations = contentResolution.resolved;
  const contentContext = wordpressContentContext(context.product, title, contentVariations, modelTagLink);
  const contentTemplates = context.contentTemplates ?? [];
  const content = renderWordPressContentFields(contentContext, contentTemplates, taxonomyTermIds(taxonomies, "product_cat"));
  const managedFields = ["title", "slug", "sku"];
  if (content.descriptionHtml !== undefined) managedFields.push("description");
  if (content.shortDescriptionHtml !== undefined) managedFields.push("short_description");
  managedFields.push("images", "taxonomies", "variations");
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
      ...(content.descriptionHtml === undefined ? {} : { description_html: content.descriptionHtml }),
      ...(content.shortDescriptionHtml === undefined ? {} : { short_description_html: content.shortDescriptionHtml }),
      status: "publish",
      images: context.product.images.map((image) => imagePayload(image, sourceExternalId)),
      taxonomies,
    },
    variations: { mode: "replace_active_set", missing_policy: "out_of_stock", items: variations },
    ...(content.descriptionStoryPolicy === undefined ? {} : { content_policy: { description_story: content.descriptionStoryPolicy } }),
  };
  const idempotencyKey = `product-upsert:${hashStableJson(base)}`;
  const payload = { ...base, idempotency_key: idempotencyKey } satisfies JsonObject;
  return {
    payload: { ...payload, payload_hash: hashStableJson(payload) },
    missingRequiredReferences: missingRequired,
    ignoredSizeVariants: [...new Map(
      [...outputResolution.ignored, ...contentResolution.ignored]
        .map((variant) => [variant.sourceVariantKey, variant]),
    ).values()],
    contentContext,
    contentTemplateSelections: content.selections,
    taxonomyOrigins,
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

function withoutLiveVariants(context: ExportContext): ExportContext {
  const { liveVariants: _liveVariants, ...storedContext } = context;
  return storedContext;
}

export class WordPressExporter {
  readonly targetCode = "wordpress";
  readonly version = "1.11.0";
  private readonly sizeConverter: WordPressSizeConverterLike;

  constructor(
    private readonly config: WordPressTargetConfig,
    private readonly requestImplementation: typeof fetch = fetch,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.sizeConverter = new WordPressSizeConverter(config, requestImplementation);
  }

  async previewPayload(context: ExportContext): Promise<WordPressUpsertPayloadPreview> {
    const effectiveContext = preserveExistingBrandTerms(context.target.config)
      && context.existingTargetSnapshot === undefined
      && context.existingExternalId !== undefined
      ? await this.withCurrentBrandSnapshot(context)
      : context;
    return previewWordPressUpsertPayload(effectiveContext, this.sizeConverter);
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
    const snapshot = response.snapshot === undefined
      ? undefined
      : record(response.snapshot, "WordPress preflight snapshot") as JsonObject;
    if (matchedBy === "legacy_sku" && snapshot === undefined) {
      throw new IntegrationContractError("WordPress legacy SKU preflight snapshot is required");
    }
    const contentPolicy = payload.content_policy === undefined ? null : record(payload.content_policy, "WordPress content_policy");
    const expectsStoryResolution = contentPolicy !== null && contentPolicy.description_story !== undefined;
    let resolvedDescriptionHtml: string | undefined;
    let resolvedStorySource: "wordpress_existing" | "empty" | undefined;
    if (expectsStoryResolution) {
      const resolved = record(response.resolved_content, "WordPress preflight resolved_content");
      if (typeof resolved.description_html !== "string") {
        throw new IntegrationContractError("WordPress preflight resolved_content.description_html must be a string");
      }
      if (resolved.story_source !== "wordpress_existing" && resolved.story_source !== "empty") {
        throw new IntegrationContractError("WordPress preflight resolved_content.story_source is invalid");
      }
      resolvedDescriptionHtml = resolved.description_html;
      resolvedStorySource = resolved.story_source;
    }
    return {
      externalId,
      willCreate,
      matchedBy,
      payloadHash,
      variationPlan,
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(resolvedDescriptionHtml === undefined ? {} : { resolvedDescriptionHtml }),
      ...(resolvedStorySource === undefined ? {} : { resolvedStorySource }),
    };
  }

  async export(context: ExportContext): Promise<ExportResult> {
    const effectiveContext = preserveExistingBrandTerms(context.target.config)
      ? await this.withCurrentBrandSnapshot(context)
      : context;
    const payload = await this.buildPayload(effectiveContext);
    const expectedPayloadHash = text(payload.payload_hash);
    const managedFields = Array.isArray(payload.managed_fields) ? payload.managed_fields.map(String) : [];
    if (!managedFields.includes("description") && context.approval === undefined) {
      const current = await this.preflightPayload(payload);
      if (current.willCreate) {
        throw new IntegrationContractError("Нельзя создать товар без управляемого описания: для нового товара нечего сохранять без изменений");
      }
    }
    if (context.approval !== undefined) {
      if (!managedFields.includes("description") && context.approval.willCreate) {
        throw new IntegrationContractError("Нельзя создать товар без управляемого описания: для нового товара нечего сохранять без изменений");
      }
      const approvedPayload = effectiveContext.liveVariants === undefined
        ? payload
        : await this.buildPayload(withoutLiveVariants(effectiveContext));
      if (text(approvedPayload.payload_hash) !== context.approval.payloadHash) {
        throw new IntegrationContractError("WordPress payload изменился после подтверждённого preflight");
      }
      const current = await this.preflightPayload(payload);
      if (current.willCreate !== context.approval.willCreate
        || current.externalId !== context.approval.externalId
        || current.matchedBy !== context.approval.matchedBy) {
        throw new IntegrationContractError("Состояние товара WordPress изменилось после подтверждённого preflight");
      }
      if (context.approval.wordpressStateHash !== undefined) {
        const currentStateHash = hashStableJson({ externalId: current.externalId, snapshot: current.snapshot ?? null });
        if (currentStateHash !== context.approval.wordpressStateHash) {
          throw new IntegrationContractError("Товар WordPress изменился после сохранённого снимка; обновите preflight перед экспортом");
        }
      }
    }
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

  private async withCurrentBrandSnapshot(context: ExportContext): Promise<ExportContext> {
    const lookupContext: ExportContext = {
      ...context,
      target: {
        ...context.target,
        config: { ...context.target.config, preserveExistingBrandTerms: false },
      },
    };
    const lookup = await this.preflightPayload(await this.buildPayload(lookupContext));
    if (!lookup.willCreate && lookup.snapshot === undefined) {
      throw new IntegrationContractError("WordPress preflight snapshot is required to preserve existing brand terms");
    }
    const {
      existingExternalId: _existingExternalId,
      existingTargetSnapshot: _existingTargetSnapshot,
      ...baseContext
    } = context;
    return {
      ...baseContext,
      ...(lookup.externalId === null ? {} : { existingExternalId: lookup.externalId }),
      ...(lookup.snapshot === undefined ? {} : { existingTargetSnapshot: lookup.snapshot }),
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
