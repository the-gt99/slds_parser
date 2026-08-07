import type { WordPressTargetConfig } from "../../config/index.js";
import type { JsonObject } from "../../contracts/index.js";
import { IntegrationContractError, RetryableError } from "../../core/errors/index.js";

export interface WordPressProductSnapshotResult {
  readonly sourceExternalId: string;
  readonly found: boolean;
  readonly externalId?: string;
  readonly matchedBy?: string;
  readonly snapshot?: JsonObject;
  readonly errorCode?: string;
}

interface SnapshotResponse {
  readonly ok?: unknown;
  readonly error?: unknown;
  readonly items?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function normalizeItem(value: unknown): WordPressProductSnapshotResult {
  const item = record(value, "WordPress product snapshot item");
  const sourceExternalId = text(item.source_external_id);
  if (sourceExternalId === "") throw new IntegrationContractError("WordPress product snapshot source_external_id is required");
  if (item.found === false) {
    return { sourceExternalId, found: false, ...(text(item.error_code) === "" ? {} : { errorCode: text(item.error_code) }) };
  }
  if (item.found !== true) throw new IntegrationContractError(`WordPress product snapshot ${sourceExternalId} has invalid found state`);
  const externalId = String(item.target_id ?? "").trim();
  if (!/^\d+$/u.test(externalId) || BigInt(externalId) <= 0n) {
    throw new IntegrationContractError(`WordPress product snapshot ${sourceExternalId} has invalid target_id`);
  }
  const matchedBy = text(item.matched_by);
  if (matchedBy === "") throw new IntegrationContractError(`WordPress product snapshot ${sourceExternalId} has invalid matched_by`);
  return {
    sourceExternalId,
    found: true,
    externalId,
    matchedBy,
    snapshot: record(item.snapshot, `WordPress product snapshot ${sourceExternalId}`) as JsonObject,
  };
}

export class WordPressProductSnapshotReader {
  constructor(
    private readonly config: WordPressTargetConfig,
    private readonly requestImplementation: typeof fetch = fetch,
  ) {}

  async read(sourceCode: string, sourceExternalIds: readonly string[]): Promise<readonly WordPressProductSnapshotResult[]> {
    const normalizedSourceCode = sourceCode.trim().toLocaleLowerCase("en-US");
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(normalizedSourceCode)) {
      throw new IntegrationContractError(`Source code cannot be used for WordPress snapshots: ${sourceCode}`);
    }
    const ids = [...new Set(sourceExternalIds.map((value) => value.trim()))];
    if (ids.length === 0 || ids.length > 100 || ids.some((value) => value === "" || value.length > 150)) {
      throw new IntegrationContractError("WordPress snapshots require from 1 to 100 valid source external IDs");
    }

    const url = new URL(`${this.config.baseUrl}/`);
    url.searchParams.set("slds_target_import_api", "product-snapshots");
    let response: Response;
    try {
      response = await this.requestImplementation(url, {
        method: "POST",
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "SLDS-Parser/wordpress-snapshot-reader",
          "X-SLDS-Import-Token": this.config.authToken,
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({ source_code: normalizedSourceCode, source_external_ids: ids }),
      });
    } catch (cause) {
      throw new RetryableError("WordPress product snapshot request failed", { code: "WORDPRESS_SNAPSHOT_REQUEST_FAILED", cause });
    }

    const body = await response.text();
    let decoded: SnapshotResponse;
    try {
      decoded = JSON.parse(body.replace(/^\uFEFF/u, "")) as SnapshotResponse;
    } catch (cause) {
      if (retryableHttpStatus(response.status)) {
        throw new RetryableError(`WordPress snapshot reader returned invalid JSON with HTTP ${response.status}`, { code: "WORDPRESS_SNAPSHOT_INVALID_RESPONSE", cause });
      }
      throw new IntegrationContractError(`WordPress snapshot reader returned invalid JSON with HTTP ${response.status}`, { cause });
    }
    if (!response.ok || decoded.ok !== true) {
      const message = text(decoded.error) || `HTTP ${response.status}`;
      if (retryableHttpStatus(response.status)) {
        throw new RetryableError(`WordPress snapshot request failed: ${message}`, { code: "WORDPRESS_SNAPSHOT_HTTP_ERROR" });
      }
      throw new IntegrationContractError(`WordPress snapshot request failed: ${message}`);
    }
    if (!Array.isArray(decoded.items)) throw new IntegrationContractError("WordPress snapshot response items must be an array");
    const items = decoded.items.map(normalizeItem);
    const returnedIds = new Set(items.map((item) => item.sourceExternalId));
    if (items.length !== ids.length || ids.some((id) => !returnedIds.has(id))) {
      throw new IntegrationContractError("WordPress snapshot response does not cover every requested source external ID");
    }
    return items;
  }
}
