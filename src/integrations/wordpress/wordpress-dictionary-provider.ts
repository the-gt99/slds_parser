import { IntegrationContractError, RetryableError } from "../../core/errors/index.js";
import type { WordPressTargetConfig } from "../../config/index.js";
import type {
  CreateTargetTermInput,
  TargetDictionaryPage,
  TargetDictionaryProvider,
  TargetDictionaryRemoteValue,
} from "../target-dictionary-provider.js";

interface WordPressResponse {
  readonly ok?: unknown;
  readonly error?: unknown;
  readonly items?: unknown;
  readonly has_more?: unknown;
  readonly next_page?: unknown;
  readonly term?: unknown;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function positiveIdText(value: unknown): string | null {
  const text = nullableText(value);
  if (text === null || !/^\d+$/u.test(text) || BigInt(text) <= 0n) return null;
  return text;
}

function remoteValue(value: unknown, entityType: string): TargetDictionaryRemoteValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationContractError("WordPress dictionary item must be an object");
  }
  const row = value as Record<string, unknown>;
  const externalId = positiveIdText(row.target_id ?? row.term_id);
  const name = nullableText(row.name);
  if (externalId === null || name === null) {
    throw new IntegrationContractError("WordPress dictionary item is missing target_id or name");
  }
  return {
    externalId,
    name,
    slug: nullableText(row.slug ?? row.term_slug),
    parentExternalId: positiveIdText(row.parent_target_id),
    taxonomy: nullableText(row.taxonomy),
    attributeCode: nullableText(row.attribute_code),
    remoteUpdatedAt: nullableText(row.updated_at),
    syncCursor: nullableText(row.sync_cursor),
    metadata: {
      entityType,
      ...(row.raw_meta !== null && typeof row.raw_meta === "object" && !Array.isArray(row.raw_meta)
        ? { rawMeta: row.raw_meta as Record<string, never> }
        : {}),
    },
  };
}

export class WordPressDictionaryProvider implements TargetDictionaryProvider {
  readonly code = "wordpress";
  readonly supportedEntityTypes = [
    "brands",
    "models",
    "tags",
    "sizes",
    "shoe_heights",
    "product_categories",
    "colors",
    "materials",
    "seasons",
    "activities",
  ] as const;
  readonly creatableEntityTypes = ["brands", "models", "tags", "product_categories"] as const;
  readonly classificationCapabilities = [
    { typeCode: "brand", entityType: "brands", targetScope: "product.brand", cardinality: "single" },
    { typeCode: "model", entityType: "models", targetScope: "product.model", cardinality: "single" },
    { typeCode: "category", entityType: "product_categories", targetScope: "product.category", cardinality: "single" },
    { typeCode: "tag", entityType: "tags", targetScope: "product.tag", cardinality: "multiple" },
    { typeCode: "color", entityType: "colors", targetScope: "product.color", cardinality: "single" },
    { typeCode: "material", entityType: "materials", targetScope: "product.material", cardinality: "multiple" },
    { typeCode: "activity", entityType: "activities", targetScope: "product.activity", cardinality: "multiple" },
    { typeCode: "shoe_height", entityType: "shoe_heights", targetScope: "product.shoe_height", cardinality: "single" },
    { typeCode: "season", entityType: "seasons", targetScope: "product.season", cardinality: "single" },
  ] as const;

  constructor(private readonly config: WordPressTargetConfig) {}

  productEditUrl(externalId: string): string {
    const url = new URL(`${this.config.baseUrl}/wp-admin/post.php`);
    url.searchParams.set("post", externalId);
    url.searchParams.set("action", "edit");
    return url.toString();
  }

  async fetchPage(entityType: string, page: number, perPage: number): Promise<TargetDictionaryPage> {
    this.ensureSupported(entityType, this.supportedEntityTypes);
    const url = this.endpoint("dictionaries");
    url.searchParams.set("entity_type", entityType);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));
    const response = await this.request(url, { method: "GET" });
    const items = Array.isArray(response.items) ? response.items : [];
    return {
      values: items.map((item) => remoteValue(item, entityType)),
      hasMore: response.has_more === true,
      nextPage: response.next_page === null || response.next_page === undefined
        ? null
        : Number(response.next_page),
    };
  }

  async createTerm(input: CreateTargetTermInput): Promise<TargetDictionaryRemoteValue> {
    this.ensureSupported(input.entityType, this.creatableEntityTypes);
    const response = await this.request(this.endpoint("create-term"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity_type: input.entityType,
        name: input.name,
        source_value: input.sourceValue,
        donor_id: input.sourceCode,
        mapping_id: input.requestReference,
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(input.parentExternalId === undefined ? {} : { parent_target_id: input.parentExternalId }),
      }),
    });
    return remoteValue(response.term, input.entityType);
  }

  private endpoint(action: string): URL {
    const url = new URL(`${this.config.baseUrl}/`);
    url.searchParams.set("slds_target_import_api", action);
    return url;
  }

  private async request(url: URL, init: RequestInit): Promise<WordPressResponse> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          Accept: "application/json",
          "User-Agent": "SLDS-Parser/target-dictionary",
          "X-SLDS-Import-Token": this.config.authToken,
          Authorization: `Bearer ${this.config.authToken}`,
          ...init.headers,
        },
      });
    } catch (error) {
      throw new RetryableError("WordPress dictionary request failed", {
        code: "TARGET_DICTIONARY_REQUEST_FAILED",
        cause: error,
      });
    }

    const body = await response.text();
    let decoded: WordPressResponse;
    try {
      decoded = JSON.parse(body.replace(/^\uFEFF/u, "")) as WordPressResponse;
    } catch (error) {
      throw new IntegrationContractError(`WordPress dictionary returned invalid JSON with HTTP ${response.status}`, { cause: error });
    }
    if (!response.ok || decoded.ok !== true) {
      const remoteMessage = typeof decoded.error === "string" ? decoded.error.trim() : "";
      throw new IntegrationContractError(
        remoteMessage === ""
          ? `WordPress dictionary request failed with HTTP ${response.status}`
          : `WordPress dictionary request failed: ${remoteMessage}`,
      );
    }
    return decoded;
  }

  private ensureSupported(entityType: string, supported: readonly string[]): void {
    if (!supported.includes(entityType)) {
      throw new IntegrationContractError(`Unsupported WordPress dictionary entity type: ${entityType}`);
    }
  }
}
