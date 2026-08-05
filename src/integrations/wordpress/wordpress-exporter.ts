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

function resolveSize(size: ProductSizeDTO, mappings: readonly SizeMapping[]): SizeMapping {
  const matches = mappings.filter((mapping) => mappingMatches(mapping, size));
  const key = [size.system ?? "", size.audience ?? "", size.sourceValue, size.displayValue].join("/");
  if (matches.length === 0) throw new IntegrationContractError(`WordPress size mapping is missing: ${key}`);
  const specificity = (mapping: SizeMapping): number => [mapping.displayValue, mapping.system, mapping.audience]
    .filter((value) => value !== undefined).length;
  const mostSpecific = Math.max(...matches.map(specificity));
  const winners = matches.filter((mapping) => specificity(mapping) === mostSpecific);
  if (winners.length > 1) throw new IntegrationContractError(`WordPress size mapping is ambiguous: ${key}`);
  return winners[0]!;
}

function mappedTargetScope(config: JsonObject, defaultScope: string): string {
  const configured = config.targetScopeMap;
  if (configured === null || typeof configured !== "object" || Array.isArray(configured)) return defaultScope;
  return text((configured as JsonObject)[defaultScope]) || defaultScope;
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
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#039;");
}

function paragraphHtml(value: string): string {
  return value.trim() === "" ? "" : value.trim().split(/\r?\n\s*\r?\n/gu).map((item) => `<p>${escapeHtml(item.replace(/\s+/gu, " ").trim())}</p>`).join("\n");
}

function descriptionHtml(product: UniversalProductDTO): string {
  const translated = product.translatedContent;
  const story = translated?.story || translated?.description || product.description;
  const properties = [
    ["Артикул", product.sku],
    ["Цвет", translated?.color ?? ""],
    ["Расцветка", translated?.details ?? ""],
    ["Материал верха", translated?.upperMaterial ?? ""],
    ["Дата релиза", text(product.attributes.releaseDate)],
  ].filter((entry) => entry[1] !== "");
  const parts = [`<h2>${escapeHtml(product.title)}</h2>`];
  const storyHtml = paragraphHtml(story);
  if (storyHtml !== "") parts.push(storyHtml);
  if (properties.length > 0) {
    parts.push(`<ul>\n${properties.map(([name, value]) => `<li>${escapeHtml(name!)}: ${escapeHtml(value!)}</li>`).join("\n")}\n</ul>`);
  }
  return parts.join("\n");
}

function variationPayload(variant: ProductVariantDTO, identityKey: string, mappings: readonly SizeMapping[]): JsonObject {
  const size = resolveSize(variant.size, mappings);
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
  return {
    variation_key: `${identityKey}|${variant.sourceVariantKey}`,
    source_variant_key: variant.sourceVariantKey,
    sku: variant.sku,
    size: { taxonomy: size.taxonomy, term_id: size.termId },
    price,
    inventory: {
      availability: variant.inventory.availability,
      ...(variant.inventory.quantity === undefined ? {} : { quantity: variant.inventory.quantity }),
    },
  };
}

async function taxonomyPayload(context: ExportContext, required: readonly ReferenceType[]): Promise<JsonObject> {
  if (context.product.classification?.status !== "complete") {
    throw new IntegrationContractError("Product classification must be complete before WordPress export");
  }
  const grouped = new Map<string, Set<number>>();
  for (const candidate of context.product.referenceCandidates) {
    if (candidate.subjectKind !== "product" || !(candidate.typeCode in REFERENCE_TARGETS)) continue;
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
  const invalidSingleTypes = [...termsByType.entries()]
    .filter(([type, termIds]) => REFERENCE_TARGETS[type].cardinality === "single" && termIds.size > 1)
    .map(([type]) => type);
  if (invalidSingleTypes.length > 0) {
    throw new IntegrationContractError(`WordPress single-value references contain multiple terms: ${invalidSingleTypes.join(", ")}`);
  }
  const missing = required.filter((type) => !presentTypes.has(type));
  if (missing.length > 0) throw new IntegrationContractError(`Required WordPress references are missing: ${missing.join(", ")}`);
  return Object.fromEntries([...grouped.entries()].map(([taxonomy, termIds]) => [taxonomy, { mode: "replace", term_ids: [...termIds] }]));
}

export async function buildWordPressUpsertPayload(context: ExportContext): Promise<JsonObject> {
  const sourceExternalId = context.sourceProduct.externalId?.trim() ?? "";
  if (sourceExternalId === "") throw new IntegrationContractError("Source product externalId is required for WordPress export");
  const sourceCode = context.source.code.trim().toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(sourceCode)) throw new IntegrationContractError(`Source code cannot be used in WordPress identity: ${context.source.code}`);
  const externalKey = `${sourceCode}:${sourceExternalId}`;
  const required = requiredReferenceTypes(context.target.config);
  const mappings = sizeMappings(context.target.config);
  const taxonomies = await taxonomyPayload(context, required);
  const variations = context.product.variants.map((variant) => variationPayload(variant, externalKey, mappings));
  const targetSizes = new Set(variations.map((variation) => {
    const size = variation.size as JsonObject;
    return `${String(size.taxonomy)}:${String(size.term_id)}`;
  }));
  if (targetSizes.size !== variations.length) throw new IntegrationContractError("More than one product variant resolves to the same WordPress size");
  const targetId = context.existingExternalId === undefined ? 0 : positiveInteger(context.existingExternalId, "existingExternalId");
  const base: JsonObject = {
    contract_version: CONTRACT_VERSION,
    mode: "upsert",
    identity: {
      source_code: sourceCode,
      source_external_id: sourceExternalId,
      external_key: externalKey,
      target_id: targetId,
    },
    managed_fields: ["title", "slug", "sku", "description", "short_description", "images", "taxonomies", "variations"],
    product: {
      title: context.product.title,
      slug: context.sourceProduct.slug ?? "",
      sku: context.product.sku,
      description_html: descriptionHtml(context.product),
      short_description_html: "",
      status: "publish",
      images: context.product.images.map((image) => imagePayload(image, sourceExternalId)),
      taxonomies,
    },
    variations: { mode: "replace_active_set", missing_policy: "out_of_stock", items: variations },
  };
  const idempotencyKey = `product-upsert:${hashStableJson(base)}`;
  const payload = { ...base, idempotency_key: idempotencyKey } satisfies JsonObject;
  return { ...payload, payload_hash: hashStableJson(payload) };
}

function normalizeJob(value: unknown): WordPressJob {
  return record(value, "WordPress job") as WordPressJob;
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class WordPressExporter {
  readonly targetCode = "wordpress";
  readonly version = "1.0.1";

  constructor(
    private readonly config: WordPressTargetConfig,
    private readonly requestImplementation: typeof fetch = fetch,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async export(context: ExportContext): Promise<ExportResult> {
    const payload = await buildWordPressUpsertPayload(context);
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
