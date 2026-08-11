import type { JsonValue } from "../contracts/index.js";
import { InvalidJobPayloadError } from "../core/errors/index.js";

export interface DiscoverSourcePayload {
  readonly sourceId: string;
  readonly runType: string;
  readonly coverage: string;
  readonly enqueueCollection?: boolean;
}

export interface CollectProductPayload {
  readonly sourceProductId: string;
  readonly requestedPartKeys?: readonly string[];
  readonly enqueueProcessing?: boolean;
}

export interface ProcessProductPayload {
  readonly sourceProductId: string;
  readonly force: boolean;
}

export interface ExportProductPayload {
  readonly internalProductId: string;
  readonly targetId: string;
  readonly force: boolean;
  readonly batchItemId?: string;
  readonly approval?: {
    readonly preflightReviewId: string;
    readonly payloadHash: string;
    readonly willCreate: boolean;
    readonly externalId: string | null;
    readonly matchedBy: string | null;
  };
}

export interface PreflightProductPayload {
  readonly sourceProductId: string;
  readonly targetId: string;
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: JsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseDiscoverSourcePayload(value: JsonValue): DiscoverSourcePayload {
  if (isObject(value) && typeof value.sourceId === "string" && typeof value.runType === "string" && typeof value.coverage === "string"
    && (value.enqueueCollection === undefined || typeof value.enqueueCollection === "boolean")) {
    return { sourceId: value.sourceId, runType: value.runType, coverage: value.coverage,
      ...(value.enqueueCollection === undefined ? {} : { enqueueCollection: value.enqueueCollection }) };
  }
  throw new InvalidJobPayloadError("discover_source");
}

export function parseCollectProductPayload(value: JsonValue): CollectProductPayload {
  if (isObject(value) && typeof value.sourceProductId === "string"
    && (value.requestedPartKeys === undefined || isStringArray(value.requestedPartKeys))
    && (value.enqueueProcessing === undefined || typeof value.enqueueProcessing === "boolean")) {
    return {
      sourceProductId: value.sourceProductId,
      ...(value.requestedPartKeys === undefined ? {} : { requestedPartKeys: value.requestedPartKeys }),
      ...(value.enqueueProcessing === undefined ? {} : { enqueueProcessing: value.enqueueProcessing }),
    };
  }
  throw new InvalidJobPayloadError("collect_product");
}

export function parseProcessProductPayload(value: JsonValue): ProcessProductPayload {
  if (isObject(value) && typeof value.sourceProductId === "string" && typeof value.force === "boolean") {
    return { sourceProductId: value.sourceProductId, force: value.force };
  }
  throw new InvalidJobPayloadError("process_product");
}

export function parseExportProductPayload(value: JsonValue): ExportProductPayload {
  if (isObject(value) && typeof value.internalProductId === "string" && typeof value.targetId === "string" && typeof value.force === "boolean"
    && (value.batchItemId === undefined || typeof value.batchItemId === "string")) {
    let approval: ExportProductPayload["approval"];
    if (value.approval !== undefined) {
      if (!isObject(value.approval) || typeof value.approval.preflightReviewId !== "string"
        || typeof value.approval.payloadHash !== "string" || typeof value.approval.willCreate !== "boolean"
        || (value.approval.externalId !== null && typeof value.approval.externalId !== "string")
        || (value.approval.matchedBy !== null && typeof value.approval.matchedBy !== "string")) {
        throw new InvalidJobPayloadError("export_product");
      }
      approval = {
        preflightReviewId: value.approval.preflightReviewId,
        payloadHash: value.approval.payloadHash,
        willCreate: value.approval.willCreate,
        externalId: value.approval.externalId,
        matchedBy: value.approval.matchedBy,
      };
    }
    return {
      internalProductId: value.internalProductId,
      targetId: value.targetId,
      force: value.force,
      ...(value.batchItemId === undefined ? {} : { batchItemId: value.batchItemId }),
      ...(approval === undefined ? {} : { approval }),
    };
  }
  throw new InvalidJobPayloadError("export_product");
}

export function parsePreflightProductPayload(value: JsonValue): PreflightProductPayload {
  if (isObject(value) && typeof value.sourceProductId === "string" && typeof value.targetId === "string") {
    return { sourceProductId: value.sourceProductId, targetId: value.targetId };
  }
  throw new InvalidJobPayloadError("preflight_product");
}
