import type { WordPressTargetConfig } from "../../config/index.js";
import type { JsonObject } from "../../contracts/index.js";
import { IntegrationContractError, RetryableError } from "../../core/errors/index.js";

export interface WordPressCatalogPageItem {
  readonly targetId: string;
  readonly identity: JsonObject;
  readonly snapshot: JsonObject;
}

export interface WordPressCatalogPage {
  readonly items: readonly WordPressCatalogPageItem[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export interface WordPressPatchSubmission {
  readonly index: number;
  readonly accepted: boolean;
  readonly idempotentReplay: boolean;
  readonly job?: JsonObject;
  readonly code?: string;
  readonly error?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveId(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text) || BigInt(text) <= 0n) throw new IntegrationContractError(`${label} must be a positive integer`);
  return text;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class WordPressCatalogClient {
  constructor(
    private readonly config: WordPressTargetConfig,
    private readonly requestImplementation: typeof fetch = fetch,
  ) {}

  async readPage(cursor: string, limit = 250): Promise<WordPressCatalogPage> {
    if (!/^\d+$/u.test(cursor) || limit < 1 || limit > 500) throw new IntegrationContractError("Invalid WordPress catalog page request");
    const response = await this.request("catalog-export", { cursor: Number(cursor), limit });
    if (!Array.isArray(response.items)) throw new IntegrationContractError("WordPress catalog response items must be a list");
    const items = response.items.map((value, index) => {
      const item = record(value, `WordPress catalog item ${index}`);
      return {
        targetId: positiveId(item.target_id, `WordPress catalog item ${index}.target_id`),
        identity: record(item.identity, `WordPress catalog item ${index}.identity`) as JsonObject,
        snapshot: record(item.snapshot, `WordPress catalog item ${index}.snapshot`) as JsonObject,
      };
    });
    const nextCursor = String(response.next_cursor ?? "").trim();
    if (!/^\d+$/u.test(nextCursor)) throw new IntegrationContractError("WordPress catalog next_cursor is invalid");
    if (typeof response.has_more !== "boolean") throw new IntegrationContractError("WordPress catalog has_more is invalid");
    return { items, nextCursor, hasMore: response.has_more };
  }

  async submitVariationPatches(payloads: readonly JsonObject[]): Promise<readonly WordPressPatchSubmission[]> {
    if (payloads.length < 1 || payloads.length > 100) throw new IntegrationContractError("WordPress variation patch batch must contain from 1 to 100 payloads");
    const response = await this.request("variation-patch-jobs", { payloads });
    if (!Array.isArray(response.items)) throw new IntegrationContractError("WordPress variation patch response items must be a list");
    return response.items.map((value, index) => {
      const item = record(value, `WordPress variation patch result ${index}`);
      return {
        index: Number(item.index),
        accepted: item.accepted === true,
        idempotentReplay: item.idempotent_replay === true,
        ...(item.job === undefined ? {} : { job: record(item.job, `WordPress variation patch job ${index}`) as JsonObject }),
        ...(typeof item.code === "string" ? { code: item.code } : {}),
        ...(typeof item.error === "string" ? { error: item.error } : {}),
      };
    });
  }

  async readJobs(jobIds: readonly string[]): Promise<readonly JsonObject[]> {
    if (jobIds.length < 1 || jobIds.length > 500 || jobIds.some((id) => !/^\d+$/u.test(id))) {
      throw new IntegrationContractError("WordPress jobs status request must contain from 1 to 500 IDs");
    }
    const response = await this.request("jobs-status", { job_ids: jobIds.map(Number) });
    if (!Array.isArray(response.jobs)) throw new IntegrationContractError("WordPress jobs status response must contain jobs");
    return response.jobs.map((job, index) => record(job, `WordPress job ${index}`) as JsonObject);
  }

  private async request(action: string, body: JsonObject): Promise<Record<string, unknown>> {
    const url = new URL(`${this.config.baseUrl}/`);
    url.searchParams.set("slds_target_import_api", action);
    let response: Response;
    try {
      response = await this.requestImplementation(url, {
        method: "POST",
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "SLDS-Parser/wordpress-catalog",
          "X-SLDS-Import-Token": this.config.authToken,
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new RetryableError(`WordPress ${action} request failed`, { code: "WORDPRESS_CATALOG_REQUEST_FAILED", cause });
    }
    const raw = await response.text();
    let decoded: Record<string, unknown>;
    try {
      decoded = record(JSON.parse(raw.replace(/^\uFEFF/u, "")), `WordPress ${action} response`);
    } catch (cause) {
      if (retryableStatus(response.status)) throw new RetryableError(`WordPress ${action} returned invalid JSON`, { code: "WORDPRESS_CATALOG_INVALID_RESPONSE", cause });
      throw new IntegrationContractError(`WordPress ${action} returned invalid JSON`, { cause });
    }
    if (!response.ok || decoded.ok !== true) {
      const message = typeof decoded.error === "string" ? decoded.error : `HTTP ${response.status}`;
      if (retryableStatus(response.status)) throw new RetryableError(`WordPress ${action} failed: ${message}`, { code: "WORDPRESS_CATALOG_HTTP_ERROR" });
      throw new IntegrationContractError(`WordPress ${action} failed: ${message}`);
    }
    return decoded;
  }
}
