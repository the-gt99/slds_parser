import type { JsonValue } from "../contracts/index.js";
import { InvalidJobPayloadError } from "../core/errors/index.js";

export interface DiscoverSourcePayload {
  readonly sourceId: string;
  readonly runType: string;
  readonly coverage: string;
  readonly enqueueCollection?: boolean;
  readonly enqueueNewCollection?: boolean;
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

export interface ReclassifyProductPayload {
  readonly sourceProductId: string;
}

export interface RetranslateProductPayload {
  readonly sourceProductId: string;
}

export interface ResolveShihuoProductPayload { readonly sourceProductId: string; }

export interface ExportProductPayload {
  readonly internalProductId: string;
  readonly targetId: string;
  readonly force: boolean;
  readonly batchItemId?: string;
  readonly sourceRefreshId?: string;
  readonly approval?: {
    readonly preflightReviewId: string;
    readonly payloadHash: string;
    readonly willCreate: boolean;
    readonly externalId: string | null;
    readonly matchedBy: string | null;
    readonly wordpressStateHash?: string | null;
  };
}

export interface RefreshExportSourcePayload {
  readonly refreshId: string;
}

export interface PreflightProductPayload {
  readonly sourceProductId: string;
  readonly targetId: string;
  readonly refreshWordPress?: boolean;
}

export interface SyncTargetClassificationsPayload {
  readonly runId: string;
  readonly cursor: string;
}

export interface ApplyTargetClassificationSuggestionPayload {
  readonly runId: string;
  readonly suggestionId: string;
  readonly actor: string;
}

export interface SyncWordPressCatalogPayload {
  readonly runId: string;
  readonly cursor: string;
  /** Inventory reconciliation uses a target_products cursor, not a catalog cursor. */
  readonly mode?: "inventory";
}

export interface PrepareWordPressVariationPatchesPayload {
  readonly runId: string;
  readonly afterCursor: string;
  readonly throughCursor: string;
}

export interface PollWordPressVariationPatchesPayload {
  readonly runId: string;
  readonly jobIds: readonly string[];
  readonly poll: number;
}

export interface CollectWordPressVariationSourcePayload {
  readonly runId: string;
  readonly itemId: string;
  readonly wordpressProductId: string;
  readonly force?: boolean;
}

export interface PrepareWordPressVariationPatchPayload {
  readonly runId: string;
  readonly itemId: string;
  readonly wordpressProductId: string;
  readonly force?: boolean;
}

export interface SubmitWordPressVariationPatchesPayload {
  readonly runId: string;
  readonly itemIds: readonly string[];
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: JsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseDiscoverSourcePayload(value: JsonValue): DiscoverSourcePayload {
  if (isObject(value) && typeof value.sourceId === "string" && typeof value.runType === "string" && typeof value.coverage === "string"
    && (value.enqueueCollection === undefined || typeof value.enqueueCollection === "boolean")
    && (value.enqueueNewCollection === undefined || typeof value.enqueueNewCollection === "boolean")) {
    return { sourceId: value.sourceId, runType: value.runType, coverage: value.coverage,
      ...(value.enqueueCollection === undefined ? {} : { enqueueCollection: value.enqueueCollection }),
      ...(value.enqueueNewCollection === undefined ? {} : { enqueueNewCollection: value.enqueueNewCollection }) };
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

export function parseReclassifyProductPayload(value: JsonValue): ReclassifyProductPayload {
  if (isObject(value) && typeof value.sourceProductId === "string" && /^\d+$/u.test(value.sourceProductId)) {
    return { sourceProductId: value.sourceProductId };
  }
  throw new InvalidJobPayloadError("reclassify_product");
}

export function parseRetranslateProductPayload(value: JsonValue): RetranslateProductPayload {
  if (isObject(value) && typeof value.sourceProductId === "string" && /^\d+$/u.test(value.sourceProductId)) {
    return { sourceProductId: value.sourceProductId };
  }
  throw new InvalidJobPayloadError("retranslate_product");
}

export function parseResolveShihuoProductPayload(value: JsonValue): ResolveShihuoProductPayload {
  if (isObject(value) && typeof value.sourceProductId === "string" && /^\d+$/u.test(value.sourceProductId)) return { sourceProductId: value.sourceProductId };
  throw new InvalidJobPayloadError("resolve_shihuo_product");
}

export function parseExportProductPayload(value: JsonValue): ExportProductPayload {
  if (isObject(value) && typeof value.internalProductId === "string" && typeof value.targetId === "string" && typeof value.force === "boolean"
    && (value.batchItemId === undefined || typeof value.batchItemId === "string")
    && (value.sourceRefreshId === undefined || (typeof value.sourceRefreshId === "string" && /^\d+$/u.test(value.sourceRefreshId)))) {
    let approval: ExportProductPayload["approval"];
    if (value.approval !== undefined) {
      if (!isObject(value.approval) || typeof value.approval.preflightReviewId !== "string"
        || typeof value.approval.payloadHash !== "string" || typeof value.approval.willCreate !== "boolean"
        || (value.approval.externalId !== null && typeof value.approval.externalId !== "string")
        || (value.approval.matchedBy !== null && typeof value.approval.matchedBy !== "string")
        || (value.approval.wordpressStateHash !== undefined && value.approval.wordpressStateHash !== null && typeof value.approval.wordpressStateHash !== "string")) {
        throw new InvalidJobPayloadError("export_product");
      }
      approval = {
        preflightReviewId: value.approval.preflightReviewId,
        payloadHash: value.approval.payloadHash,
        willCreate: value.approval.willCreate,
        externalId: value.approval.externalId,
        matchedBy: value.approval.matchedBy,
        ...(value.approval.wordpressStateHash === undefined ? {} : { wordpressStateHash: value.approval.wordpressStateHash }),
      };
    }
    return {
      internalProductId: value.internalProductId,
      targetId: value.targetId,
      force: value.force,
      ...(value.batchItemId === undefined ? {} : { batchItemId: value.batchItemId }),
      ...(value.sourceRefreshId === undefined ? {} : { sourceRefreshId: value.sourceRefreshId }),
      ...(approval === undefined ? {} : { approval }),
    };
  }
  throw new InvalidJobPayloadError("export_product");
}

export function parseRefreshExportSourcePayload(value: JsonValue): RefreshExportSourcePayload {
  if (isObject(value) && typeof value.refreshId === "string" && /^\d+$/u.test(value.refreshId)) {
    return { refreshId: value.refreshId };
  }
  throw new InvalidJobPayloadError("refresh_export_source");
}

export function parsePreflightProductPayload(value: JsonValue): PreflightProductPayload {
  if (isObject(value) && typeof value.sourceProductId === "string" && typeof value.targetId === "string"
    && (value.refreshWordPress === undefined || typeof value.refreshWordPress === "boolean")) {
    return { sourceProductId: value.sourceProductId, targetId: value.targetId,
      ...(value.refreshWordPress === undefined ? {} : { refreshWordPress: value.refreshWordPress }) };
  }
  throw new InvalidJobPayloadError("preflight_product");
}

export function parseSyncTargetClassificationsPayload(value: JsonValue): SyncTargetClassificationsPayload {
  if (isObject(value) && typeof value.runId === "string" && typeof value.cursor === "string"
    && /^\d+$/u.test(value.runId) && /^\d+$/u.test(value.cursor)) {
    return { runId: value.runId, cursor: value.cursor };
  }
  throw new InvalidJobPayloadError("sync_target_classifications");
}

export function parseApplyTargetClassificationSuggestionPayload(value: JsonValue): ApplyTargetClassificationSuggestionPayload {
  if (isObject(value) && typeof value.runId === "string" && typeof value.suggestionId === "string"
    && typeof value.actor === "string" && value.actor.trim() !== ""
    && /^\d+$/u.test(value.runId) && /^\d+$/u.test(value.suggestionId)) {
    return { runId: value.runId, suggestionId: value.suggestionId, actor: value.actor };
  }
  throw new InvalidJobPayloadError("apply_target_classification_suggestion");
}

export function parseSyncWordPressCatalogPayload(value: JsonValue): SyncWordPressCatalogPayload {
  if (isObject(value) && typeof value.runId === "string" && typeof value.cursor === "string"
    && /^\d+$/u.test(value.runId) && /^\d+$/u.test(value.cursor)
    && (value.mode === undefined || value.mode === "inventory")) {
    return { runId: value.runId, cursor: value.cursor, ...(value.mode === "inventory" ? { mode: "inventory" as const } : {}) };
  }
  throw new InvalidJobPayloadError("sync_wordpress_catalog");
}

export function parsePrepareWordPressVariationPatchesPayload(value: JsonValue): PrepareWordPressVariationPatchesPayload {
  if (isObject(value) && typeof value.runId === "string" && typeof value.afterCursor === "string" && typeof value.throughCursor === "string"
    && /^\d+$/u.test(value.runId) && /^\d+$/u.test(value.afterCursor) && /^\d+$/u.test(value.throughCursor)) {
    return { runId: value.runId, afterCursor: value.afterCursor, throughCursor: value.throughCursor };
  }
  throw new InvalidJobPayloadError("prepare_wordpress_variation_patches");
}

export function parsePollWordPressVariationPatchesPayload(value: JsonValue): PollWordPressVariationPatchesPayload {
  if (isObject(value) && typeof value.runId === "string" && /^\d+$/u.test(value.runId)
    && isStringArray(value.jobIds) && value.jobIds.length > 0 && value.jobIds.length <= 500
    && value.jobIds.every((id) => /^\d+$/u.test(id))
    && typeof value.poll === "number" && Number.isSafeInteger(value.poll) && value.poll >= 0 && value.poll <= 720) {
    return { runId: value.runId, jobIds: value.jobIds, poll: value.poll };
  }
  throw new InvalidJobPayloadError("poll_wordpress_variation_patches");
}

export function parseCollectWordPressVariationSourcePayload(value: JsonValue): CollectWordPressVariationSourcePayload {
  if (isObject(value) && typeof value.runId === "string" && typeof value.itemId === "string" && typeof value.wordpressProductId === "string"
    && /^\d+$/u.test(value.runId) && /^\d+$/u.test(value.itemId) && /^\d+$/u.test(value.wordpressProductId)
    && (value.force === undefined || typeof value.force === "boolean")) {
    return {
      runId: value.runId,
      itemId: value.itemId,
      wordpressProductId: value.wordpressProductId,
      ...(value.force === undefined ? {} : { force: value.force }),
    };
  }
  throw new InvalidJobPayloadError("collect_wordpress_variation_source");
}

export function parsePrepareWordPressVariationPatchPayload(value: JsonValue): PrepareWordPressVariationPatchPayload {
  if (isObject(value) && typeof value.runId === "string" && typeof value.itemId === "string" && typeof value.wordpressProductId === "string"
    && /^\d+$/u.test(value.runId) && /^\d+$/u.test(value.itemId) && /^\d+$/u.test(value.wordpressProductId)
    && (value.force === undefined || typeof value.force === "boolean")) {
    return {
      runId: value.runId,
      itemId: value.itemId,
      wordpressProductId: value.wordpressProductId,
      ...(value.force === undefined ? {} : { force: value.force }),
    };
  }
  throw new InvalidJobPayloadError("prepare_wordpress_variation_patch");
}

export function parseSubmitWordPressVariationPatchesPayload(value: JsonValue): SubmitWordPressVariationPatchesPayload {
  if (isObject(value) && typeof value.runId === "string" && /^\d+$/u.test(value.runId)
    && isStringArray(value.itemIds) && value.itemIds.length > 0 && value.itemIds.length <= 100
    && value.itemIds.every((id) => /^\d+$/u.test(id))) {
    return { runId: value.runId, itemIds: value.itemIds };
  }
  throw new InvalidJobPayloadError("submit_wordpress_variation_patches");
}
