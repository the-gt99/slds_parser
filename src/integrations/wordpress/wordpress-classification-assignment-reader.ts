import type { WordPressTargetConfig } from "../../config/index.js";
import type { JsonObject } from "../../contracts/index.js";
import { IntegrationContractError, RetryableError } from "../../core/errors/index.js";

export interface WordPressClassificationAssignmentItem {
  readonly sourceExternalId: string;
  readonly targetExternalId: string;
  readonly taxonomies: JsonObject;
}

export interface WordPressClassificationAssignmentPage {
  readonly items: readonly WordPressClassificationAssignmentItem[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class WordPressClassificationAssignmentReader {
  constructor(
    private readonly config: WordPressTargetConfig,
    private readonly requestImplementation: typeof fetch = fetch,
  ) {}

  async readPage(input: {
    readonly sourceCode: string;
    readonly cursor: string;
    readonly limit: number;
    readonly taxonomies: readonly string[];
  }): Promise<WordPressClassificationAssignmentPage> {
    const url = new URL(`${this.config.baseUrl}/`);
    url.searchParams.set("slds_target_import_api", "classification-assignments");
    let response: Response;
    try {
      response = await this.requestImplementation(url, {
        method: "POST",
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "SLDS-Parser/classification-assignment-reader",
          "X-SLDS-Import-Token": this.config.authToken,
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({
          source_code: input.sourceCode,
          cursor: input.cursor,
          limit: input.limit,
          taxonomies: input.taxonomies,
        }),
      });
    } catch (cause) {
      throw new RetryableError("WordPress classification assignment request failed", {
        code: "WORDPRESS_CLASSIFICATION_ASSIGNMENT_REQUEST_FAILED",
        cause,
      });
    }

    const body = await response.text();
    let decoded: Record<string, unknown>;
    try { decoded = record(JSON.parse(body.replace(/^\uFEFF/u, "")), "WordPress classification assignment response"); }
    catch (cause) {
      if (retryableStatus(response.status)) {
        throw new RetryableError(`WordPress classification assignment response is invalid with HTTP ${response.status}`, {
          code: "WORDPRESS_CLASSIFICATION_ASSIGNMENT_INVALID_RESPONSE",
          cause,
        });
      }
      throw new IntegrationContractError(`WordPress classification assignment response is invalid with HTTP ${response.status}`, { cause });
    }
    if (!response.ok || decoded.ok !== true) {
      const message = typeof decoded.error === "string" && decoded.error.trim() !== "" ? decoded.error : `HTTP ${response.status}`;
      if (retryableStatus(response.status)) {
        throw new RetryableError(`WordPress classification assignment request failed: ${message}`, {
          code: "WORDPRESS_CLASSIFICATION_ASSIGNMENT_HTTP_ERROR",
        });
      }
      throw new IntegrationContractError(`WordPress classification assignment request failed: ${message}`);
    }
    if (!Array.isArray(decoded.items)) throw new IntegrationContractError("WordPress classification assignment items must be an array");
    const items = decoded.items.map((value) => {
      const item = record(value, "WordPress classification assignment item");
      const sourceExternalId = String(item.source_external_id ?? "").trim();
      const targetExternalId = String(item.target_id ?? "").trim();
      if (sourceExternalId === "" || !/^\d+$/u.test(targetExternalId)) {
        throw new IntegrationContractError("WordPress classification assignment item has invalid identity");
      }
      return {
        sourceExternalId,
        targetExternalId,
        taxonomies: record(item.taxonomies, "WordPress classification assignment taxonomies") as JsonObject,
      };
    });
    const nextCursor = String(decoded.next_cursor ?? "").trim();
    if (!/^\d+$/u.test(nextCursor) || typeof decoded.has_more !== "boolean") {
      throw new IntegrationContractError("WordPress classification assignment response has invalid pagination");
    }
    if (decoded.has_more && BigInt(nextCursor) <= BigInt(input.cursor)) {
      throw new IntegrationContractError("WordPress classification assignment cursor did not advance");
    }
    return { items, nextCursor, hasMore: decoded.has_more };
  }
}
