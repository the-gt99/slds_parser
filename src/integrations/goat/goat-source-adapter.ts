import type { CollectedSourceProduct, CollectProductInput, DiscoveryInput, DiscoveryResult, JsonObject, JsonValue, SourceAdapter } from "../../contracts/index.js";
import { IntegrationContractError, PermanentError } from "../../core/errors/index.js";
import { GoatHttpClient, type GoatRequestExecutor } from "./goat-http-client.js";
import type { GoatProxyLease, GoatProxyPool } from "./goat-proxy-pool.js";
import { parseProductSitemap, parseSitemapIndex, sitemapMetadata, type GoatSitemapProduct } from "./sitemap.js";

interface GoatSourceConfig { sitemapUrl: string; countryCode: string; discoveryBatchSize: number; maxProductsPerRun?: number; requestDelayMs: number }
interface Checkpoint { childIndex: number; itemIndex: number; emitted: number }

function integer(value: JsonValue | undefined, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new PermanentError(`GOAT source config ${name} is invalid`, { code: "INVALID_GOAT_CONFIG" });
  return value;
}
function config(value: JsonObject): GoatSourceConfig {
  const sitemapUrl = value.sitemapUrl;
  const countryCode = value.countryCode;
  if (typeof sitemapUrl !== "string" || typeof countryCode !== "string" || !/^[A-Z]{2}$/.test(countryCode)) throw new PermanentError("GOAT source config is invalid", { code: "INVALID_GOAT_CONFIG" });
  const max = value.maxProductsPerRun;
  return { sitemapUrl, countryCode, discoveryBatchSize: integer(value.discoveryBatchSize, "discoveryBatchSize", 1), requestDelayMs: integer(value.requestDelayMs, "requestDelayMs", 0),
    ...(max === undefined ? {} : { maxProductsPerRun: integer(max, "maxProductsPerRun", 1) }) };
}
function checkpoint(value: JsonValue): Checkpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { childIndex: 0, itemIndex: 0, emitted: 0 };
  const object = value as JsonObject;
  const childIndex = typeof object.childIndex === "number" ? object.childIndex : 0;
  const itemIndex = typeof object.itemIndex === "number" ? object.itemIndex : 0;
  const emitted = typeof object.emitted === "number" ? object.emitted : 0;
  if (![childIndex, itemIndex, emitted].every((item) => Number.isSafeInteger(item) && item >= 0)) throw new PermanentError("GOAT discovery checkpoint is invalid", { code: "INVALID_GOAT_CHECKPOINT" });
  return { childIndex, itemIndex, emitted };
}
function object(value: JsonValue, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new IntegrationContractError(`GOAT ${label} response must be an object`);
  return value as JsonObject;
}
function array(value: JsonValue, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new IntegrationContractError(`GOAT ${label} response must be an array`);
  return value;
}
function isPlaceholderImageUrl(value: string): boolean {
  let path: string;
  try {
    path = new URL(value).pathname.toLowerCase();
  } catch {
    return false;
  }
  return path.includes("/placeholders/product_templates/") || path.endsWith("/missing.png") || path.endsWith("/missing.webp");
}
function productImages(card: JsonObject, discoveryMetadata: JsonObject): readonly string[] {
  const values: string[] = [];
  const add = (value: JsonValue | undefined): void => {
    if (typeof value === "string" && value.trim() !== "" && !values.includes(value.trim())) values.push(value.trim());
  };
  const main = typeof card.pictureUrl === "string" ? card.pictureUrl.trim() : "";
  add(main);
  if (Array.isArray(card.productTemplateExternalPictures)) {
    for (const [index, value] of card.productTemplateExternalPictures.entries()) {
      if (main !== "" && !isPlaceholderImageUrl(main) && index === 0) continue;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) add(value.mainPictureUrl);
    }
  }
  if (values.length === 0) {
    const direct = Array.isArray(card.pictureUrls) ? card.pictureUrls : Array.isArray(card.images) ? card.images : [];
    for (const value of direct) add(value);
  }
  if (values.length === 0 && Array.isArray(discoveryMetadata.images)) {
    for (const value of discoveryMetadata.images) add(value);
  }
  return values;
}

export class GoatSourceAdapter implements SourceAdapter {
  readonly code = "goat";
  readonly version = "1.1.0";
  readonly exportRefreshPartKeys = ["offers"] as const;
  readonly #children = new Map<string, readonly GoatSitemapProduct[]>();
  readonly #indexes = new Map<string, readonly string[]>();
  // TODO: Add ETag/304 revalidation when sitemap refresh scheduling is implemented.
  #nextRequestAt = 0;
  #client: GoatHttpClient | undefined;

  constructor(private readonly request?: GoatRequestExecutor,
    private readonly jsonRequest?: (url: string, expected: "product" | "offers") => Promise<JsonValue>,
    private readonly environment: ConstructorParameters<typeof GoatHttpClient>[0] = process.env,
    private readonly proxyPool?: GoatProxyPool) {}

  static create(environment: ConstructorParameters<typeof GoatHttpClient>[0] = process.env, proxyPool?: GoatProxyPool): GoatSourceAdapter {
    return new GoatSourceAdapter(undefined, undefined, environment, proxyPool);
  }

  #http(lease?: GoatProxyLease): GoatHttpClient {
    if (lease !== undefined) return lease.client();
    this.#client ??= new GoatHttpClient(this.environment);
    return this.#client;
  }

  async #withLease<Result>(callback: (lease?: GoatProxyLease) => Promise<Result>): Promise<Result> {
    const current = this.proxyPool?.currentLease();
    if (current !== undefined || this.proxyPool?.enabled !== true) return callback(current);
    const acquired = await this.proxyPool.acquireForImage();
    if (acquired === null) return callback(undefined);
    let success = false;
    try {
      const result = await callback(acquired);
      success = true;
      return result;
    } finally {
      await acquired.release(success, null);
    }
  }

  async #get(url: string, delay: number, lease?: GoatProxyLease): Promise<Buffer> {
    const wait = this.#nextRequestAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const result = this.request ? await this.request(url) : await this.#http(lease).getBuffer(url);
    this.#nextRequestAt = Date.now() + delay;
    return result;
  }

  async discover(input: DiscoveryInput): Promise<DiscoveryResult> {
    return this.#withLease(async (lease) => {
    const settings = config(input.source.config);
    let children = this.#indexes.get(settings.sitemapUrl);
    if (!children) { children = parseSitemapIndex(await this.#get(settings.sitemapUrl, settings.requestDelayMs, lease)); this.#indexes.set(settings.sitemapUrl, children); }
    let state = checkpoint(input.checkpoint);
    const items = [];
    while (items.length < settings.discoveryBatchSize && state.childIndex < children.length) {
      const childUrl = children[state.childIndex];
      if (!childUrl) break;
      let products = this.#children.get(childUrl);
      if (!products) { products = parseProductSitemap(await this.#get(childUrl, settings.requestDelayMs, lease)); this.#children.set(childUrl, products); }
      while (items.length < settings.discoveryBatchSize && state.itemIndex < products.length) {
        if (settings.maxProductsPerRun !== undefined && state.emitted >= settings.maxProductsPerRun) break;
        const product = products[state.itemIndex];
        if (!product) break;
        items.push({ sourceKey: product.slug, slug: product.slug, url: product.url, ...(product.lastmod ? { sourceUpdatedAt: product.lastmod } : {}), metadata: sitemapMetadata(product) });
        state = { ...state, itemIndex: state.itemIndex + 1, emitted: state.emitted + 1 };
      }
      if (settings.maxProductsPerRun !== undefined && state.emitted >= settings.maxProductsPerRun) break;
      if (state.itemIndex >= products.length) state = { ...state, childIndex: state.childIndex + 1, itemIndex: 0 };
    }
    const limited = settings.maxProductsPerRun !== undefined && state.emitted >= settings.maxProductsPerRun;
    const exhausted = state.childIndex >= children.length;
    return { items, checkpoint: { childIndex: state.childIndex, itemIndex: state.itemIndex, emitted: state.emitted }, hasMore: !limited && !exhausted, completeness: limited ? "partial" : exhausted ? "complete" : "unknown", stats: { processed: items.length, discovered: items.length } };
    });
  }

  async collectProduct(input: CollectProductInput): Promise<CollectedSourceProduct> {
    return this.#withLease(async (lease) => {
    const settings = config(input.source.config);
    const requested = input.requestedPartKeys ?? ["product", "offers"];
    for (const key of requested) if (key !== "product" && key !== "offers") throw new PermanentError(`Unknown GOAT part: ${key}`, { code: "UNKNOWN_GOAT_PART" });
    const slug = input.product.slug ?? input.product.sourceKey;
    let rawProduct: JsonValue | undefined;
    let parsedProduct: JsonObject | undefined;
    const fetchProduct = async (): Promise<void> => {
      if (parsedProduct) return;
      const url = `https://www.goat.com/web-api/v1/product_templates/${encodeURIComponent(slug)}?countryCode=${encodeURIComponent(settings.countryCode)}`;
      rawProduct = await this.#json(url, "product", settings.requestDelayMs, lease);
      const card = object(rawProduct, "product");
      if ((typeof card.id !== "string" && typeof card.id !== "number") || typeof card.name !== "string") throw new IntegrationContractError("GOAT product response is missing id or name");
      const images = productImages(card, input.product.metadata);
      parsedProduct = { ...card, id: String(card.id), images, ...(lease === undefined ? {} : { _transport: { proxy: lease.publicProxy } }) };
    };
    const parts = [];
    let externalId = input.product.externalId;
    for (const key of requested) {
      if (key === "product") {
        await fetchProduct(); externalId = String(parsedProduct!.id);
        parts.push({ partKey: "product", rawPayload: rawProduct!, parsedPayload: parsedProduct!, adapterVersion: this.version });
      } else {
        if (!externalId) { await fetchProduct(); externalId = String(parsedProduct!.id); }
        const url = `https://www.goat.com/web-api/v1/product_variants/buy_bar_data?productTemplateId=${encodeURIComponent(externalId)}&countryCode=${encodeURIComponent(settings.countryCode)}`;
        const rawOffers = await this.#json(url, "offers", settings.requestDelayMs, lease);
        const offers = array(rawOffers, "offers");
        for (const offer of offers) object(offer, "offer");
        parts.push({ partKey: "offers", rawPayload: rawOffers, parsedPayload: { market: settings.countryCode, countryCode: settings.countryCode, offers, ...(lease === undefined ? {} : { _transport: { proxy: lease.publicProxy } }) }, adapterVersion: this.version });
      }
    }
    return { sourceKey: input.product.sourceKey, ...(externalId ? { externalId } : {}), slug, ...(input.product.url ? { url: input.product.url } : {}), parts };
    });
  }

  async #json(url: string, expected: "product" | "offers", delay: number, lease?: GoatProxyLease): Promise<JsonValue> {
    const wait = this.#nextRequestAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const result = this.jsonRequest ? await this.jsonRequest(url, expected)
      : this.request ? JSON.parse((await this.request(url)).toString("utf8")) as JsonValue
        : await this.#http(lease).getJson(url, expected);
    this.#nextRequestAt = Date.now() + delay;
    return result;
  }
}
