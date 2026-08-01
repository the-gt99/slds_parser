import type { JsonValue } from "../contracts/index.js";
import { InvalidJobPayloadError } from "../core/errors/index.js";

export interface DiscoverSourcePayload {
  readonly sourceId: string;
  readonly runType: string;
  readonly coverage: string;
}

export interface CollectProductPayload {
  readonly sourceProductId: string;
  readonly requestedPartKeys?: readonly string[];
}

export interface ProcessProductPayload {
  readonly sourceProductId: string;
  readonly force: boolean;
}

export interface ExportProductPayload {
  readonly internalProductId: string;
  readonly targetId: string;
  readonly force: boolean;
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: JsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseDiscoverSourcePayload(value: JsonValue): DiscoverSourcePayload {
  if (isObject(value) && typeof value.sourceId === "string" && typeof value.runType === "string" && typeof value.coverage === "string") {
    return { sourceId: value.sourceId, runType: value.runType, coverage: value.coverage };
  }
  throw new InvalidJobPayloadError("discover_source");
}

export function parseCollectProductPayload(value: JsonValue): CollectProductPayload {
  if (isObject(value) && typeof value.sourceProductId === "string" && (value.requestedPartKeys === undefined || isStringArray(value.requestedPartKeys))) {
    return value.requestedPartKeys === undefined
      ? { sourceProductId: value.sourceProductId }
      : { sourceProductId: value.sourceProductId, requestedPartKeys: value.requestedPartKeys };
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
  if (isObject(value) && typeof value.internalProductId === "string" && typeof value.targetId === "string" && typeof value.force === "boolean") {
    return { internalProductId: value.internalProductId, targetId: value.targetId, force: value.force };
  }
  throw new InvalidJobPayloadError("export_product");
}
