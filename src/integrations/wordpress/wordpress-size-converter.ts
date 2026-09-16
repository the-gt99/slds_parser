import type { WordPressTargetConfig } from "../../config/index.js";
import type { ProductSizeDTO } from "../../contracts/index.js";
import { IntegrationContractError, RetryableError } from "../../core/errors/index.js";

const SOURCE_SYSTEMS: Readonly<Record<string, string>> = {
  "eu-numeric": "EU",
  "fr-numeric": "EU",
  "it-numeric": "EU",
  "uk-numeric": "UK",
  "jp-numeric": "JP",
  "ru-numeric": "RU",
  "cm-numeric": "CM",
};

interface WordPressSizeConverterResponse {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly conversion_table?: unknown;
  readonly conflicts?: unknown;
}

export class WordPressSizeConversionMissingError extends IntegrationContractError {}

interface ResolvedSizeTable {
  readonly values: ReadonlyMap<string, string>;
  readonly conflicts: ReadonlySet<string>;
}

export interface WordPressSizeConversionInput {
  readonly brandTermId: number;
  readonly categoryTermId: number;
  readonly size: ProductSizeDTO;
}

export interface WordPressSizeConverterLike {
  supports(size: ProductSizeDTO): boolean;
  convert(input: WordPressSizeConversionInput): Promise<ProductSizeDTO>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceSystem(system: string | undefined): string | null {
  if (system === undefined) return null;
  return SOURCE_SYSTEMS[system.trim().toLocaleLowerCase("en-US")] ?? null;
}

function canonicalUsSize(value: string, audience: ProductSizeDTO["audience"]): string {
  const normalized = value.trim().replaceAll(",", ".");
  if (audience === "youth" || audience === "infant") {
    const labeled = /^(\d+(?:\.\d+)?)[CY]$/iu.exec(normalized);
    if (labeled !== null) return labeled[1]!;
  }
  return normalized;
}

function conversionTable(value: unknown): ReadonlyMap<string, string> {
  if (value === null || typeof value !== "object") {
    throw new IntegrationContractError("WordPress size converter returned an invalid conversion table");
  }
  const entries = Object.entries(value).flatMap(([sourceValue, targetValue]) => {
    const normalizedSource = sourceValue.trim().replaceAll(",", ".");
    const normalizedTarget = text(targetValue).replaceAll(",", ".");
    return normalizedSource === "" || normalizedTarget === "" ? [] : [[normalizedSource, normalizedTarget] as const];
  });
  return new Map(entries);
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class WordPressSizeConverter implements WordPressSizeConverterLike {
  private readonly tableCache = new Map<string, Promise<ResolvedSizeTable>>();

  constructor(
    private readonly config: WordPressTargetConfig,
    private readonly requestImplementation: typeof fetch = fetch,
  ) {}

  supports(size: ProductSizeDTO): boolean {
    return sourceSystem(size.system) !== null;
  }

  async convert(input: WordPressSizeConversionInput): Promise<ProductSizeDTO> {
    const system = sourceSystem(input.size.system);
    const originalKey = [input.size.system ?? "", input.size.audience ?? "", input.size.sourceValue].join("/");
    if (system === null) {
      throw new IntegrationContractError(`WordPress size system cannot be converted: ${originalKey}`);
    }
    const audience = input.size.audience ?? "unisex";
    const cacheKey = [input.brandTermId, input.categoryTermId, system, audience].join(":");
    const pending = this.tableCache.get(cacheKey) ?? this.fetchTable({
      brandTermId: input.brandTermId,
      categoryTermId: input.categoryTermId,
      sourceSystem: system,
      audience,
    });
    this.tableCache.set(cacheKey, pending);
    let table: ResolvedSizeTable;
    try {
      table = await pending;
    } catch (error) {
      this.tableCache.delete(cacheKey);
      throw error;
    }
    const sourceValue = input.size.sourceValue.trim().replaceAll(",", ".");
    if (table.conflicts.has(sourceValue)) {
      throw new IntegrationContractError(`WordPress size conversion is ambiguous: ${originalKey}`);
    }
    const converted = table.values.get(sourceValue);
    if (converted === undefined) {
      throw new WordPressSizeConversionMissingError(`WordPress size conversion is missing: ${originalKey}`);
    }
    return {
      ...input.size,
      sourceValue: canonicalUsSize(converted, input.size.audience),
      displayValue: canonicalUsSize(converted, input.size.audience),
      system: "us-numeric",
    };
  }

  private async fetchTable(input: {
    readonly brandTermId: number;
    readonly categoryTermId: number;
    readonly sourceSystem: string;
    readonly audience: NonNullable<ProductSizeDTO["audience"]>;
  }): Promise<ResolvedSizeTable> {
    const url = new URL(`${this.config.baseUrl}/wp-json/slamdunk/size-converter/v1/convert`);
    url.searchParams.set("brand_id", String(input.brandTermId));
    url.searchParams.set("category_id", String(input.categoryTermId));
    url.searchParams.set("from_system", input.sourceSystem);
    url.searchParams.set("audience", input.audience);
    let response: Response;
    try {
      response = await this.requestImplementation(url, {
        method: "GET",
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          Accept: "application/json",
          "User-Agent": "SLDS-Parser/wordpress-size-converter",
          "X-SLDS-Import-Token": this.config.authToken,
          Authorization: `Bearer ${this.config.authToken}`,
        },
      });
    } catch (cause) {
      throw new RetryableError("WordPress size converter request failed", {
        code: "WORDPRESS_SIZE_CONVERTER_REQUEST_FAILED",
        cause,
      });
    }
    const body = await response.text();
    let decoded: WordPressSizeConverterResponse;
    try {
      decoded = JSON.parse(body.replace(/^\uFEFF/u, "")) as WordPressSizeConverterResponse;
    } catch (cause) {
      if (retryableHttpStatus(response.status)) {
        throw new RetryableError(`WordPress size converter returned invalid JSON with HTTP ${response.status}`, {
          code: "WORDPRESS_SIZE_CONVERTER_INVALID_RESPONSE",
          cause,
        });
      }
      throw new IntegrationContractError(`WordPress size converter returned invalid JSON with HTTP ${response.status}`, { cause });
    }
    if (!response.ok) {
      const message = text(decoded.message) || text(decoded.code) || `HTTP ${response.status}`;
      if (retryableHttpStatus(response.status)) {
        throw new RetryableError(`WordPress size converter request failed: ${message}`, {
          code: "WORDPRESS_SIZE_CONVERTER_HTTP_ERROR",
        });
      }
      throw new IntegrationContractError(`WordPress size converter request failed: ${message}`);
    }
    const conflicts = decoded.conflicts;
    if (conflicts !== undefined && (conflicts === null || typeof conflicts !== "object"
      || (Array.isArray(conflicts) && conflicts.length > 0))) {
      throw new IntegrationContractError("WordPress size converter returned invalid conflicts");
    }
    return { values: conversionTable(decoded.conversion_table),
      conflicts: new Set(Object.keys(conflicts ?? {}).map((key) => key.trim().replaceAll(",", "."))) };
  }
}
