import sharp from "sharp";

import type { JsonValue } from "../../contracts/index.js";
import { IntegrationContractError, PermanentError, RetryableError } from "../../core/errors/index.js";
import type {
  ShoeHeightClass,
  ShoeHeightPrediction,
  ShoeHeightPredictionProvider,
} from "../../processing/index.js";

export interface ShoeHeightApiProviderOptions {
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly attempts: number;
  readonly retryDelayMs: number;
}

const SHOE_HEIGHT_CLASSES = new Set<ShoeHeightClass>(["low", "mid", "high"]);

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationContractError("Shoe height classifier response has an invalid shape");
  }
  return value as Record<string, unknown>;
}

function optionalConfidence(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new IntegrationContractError("Shoe height classifier confidence is invalid");
  }
  return value;
}

function optionalIndex(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new IntegrationContractError("Shoe height classifier top1_index is invalid");
  }
  return value as number;
}

export class ShoeHeightApiProvider implements ShoeHeightPredictionProvider {
  readonly code = "shoe-height-api";
  readonly version = "1.0.0";
  readonly configurationFingerprint: JsonValue;

  constructor(
    private readonly options: ShoeHeightApiProviderOptions,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.apiUrl);
    } catch (cause) {
      throw new PermanentError("Shoe height classifier URL is invalid", { code: "INVALID_PROCESSING_CONFIG", cause });
    }
    if (!(["http:", "https:"] as const).includes(endpoint.protocol as "http:" | "https:")) {
      throw new PermanentError("Shoe height classifier URL must use HTTP or HTTPS", { code: "INVALID_PROCESSING_CONFIG" });
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Shoe height timeout must be a positive integer");
    if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) throw new Error("Shoe height attempts must be a positive integer");
    if (!Number.isSafeInteger(options.retryDelayMs) || options.retryDelayMs < 0) throw new Error("Shoe height retry delay must be a non-negative integer");
    this.configurationFingerprint = {
      apiUrl: endpoint.toString(),
      timeoutMs: options.timeoutMs,
      attempts: options.attempts,
      retryDelayMs: options.retryDelayMs,
    };
  }

  async predict(image: Buffer): Promise<ShoeHeightPrediction> {
    const jpeg = await sharp(image, { failOn: "warning" }).jpeg({ quality: 95 }).toBuffer();
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.attempts; attempt += 1) {
      try {
        return await this.predictOnce(jpeg);
      } catch (error) {
        lastError = error;
        if (error instanceof PermanentError || error instanceof IntegrationContractError) throw error;
        if (attempt < this.options.attempts && this.options.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs));
        }
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new RetryableError("Shoe height classifier request failed", { code: "SHOE_HEIGHT_REQUEST" });
  }

  private async predictOnce(jpeg: Buffer): Promise<ShoeHeightPrediction> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "shoe.jpg");
    let response: Response;
    try {
      response = await this.request(this.options.apiUrl, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      throw new RetryableError("Shoe height classifier transport failed", { code: "SHOE_HEIGHT_REQUEST", cause });
    }
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableError(`Shoe height classifier failed with HTTP ${response.status}`, { code: "SHOE_HEIGHT_REQUEST" });
    }
    if (!response.ok) {
      throw new PermanentError(`Shoe height classifier failed with HTTP ${response.status}`, { code: "SHOE_HEIGHT_REQUEST" });
    }

    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch (cause) {
      throw new IntegrationContractError("Shoe height classifier response is not valid JSON", { cause });
    }
    const raw = object(decoded);
    const predictedClass = raw.predicted_class;
    if (typeof predictedClass !== "string" || !SHOE_HEIGHT_CLASSES.has(predictedClass as ShoeHeightClass)) {
      throw new IntegrationContractError("Shoe height classifier returned an unknown class");
    }
    const confidence = optionalConfidence(raw.confidence);
    const top1Index = optionalIndex(raw.top1_index);
    return {
      predictedClass: predictedClass as ShoeHeightClass,
      ...(confidence === undefined ? {} : { confidence }),
      ...(top1Index === undefined ? {} : { top1Index }),
    };
  }
}
