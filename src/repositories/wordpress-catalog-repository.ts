import type { EntityId, JsonObject, ProductVariantDTO, SourceDTO, SourceProductDTO, TargetDTO, UniversalProductDTO } from "../contracts/index.js";

export type WordPressCatalogRunStatus = "running" | "paused" | "completed" | "failed";
export type WordPressCatalogMatchStatus = "matched" | "unmatched" | "ambiguous";
export type WordPressCatalogVariationFilter = "not_started" | "in_progress" | "completed" | "skipped" | "failed";
export type WordPressCatalogAuditFilter = "ready" | "blocked" | "error";
export type WordPressCatalogRiskFilter = "safe" | "review" | "danger" | "blocked";
export type WordPressCatalogOperationFilter = "update" | "new" | "unmatched";
export type WordPressVariationAutoStatus = "inactive" | "running" | "paused" | "completed";
export type WordPressVariationAutoTickOutcome = "idle" | "waiting" | "queued" | "paused" | "cycle_completed" | "cycle_started";

export interface WordPressCatalogAuditSaveInput {
  readonly itemId: EntityId;
  readonly status: "ready" | "blocked" | "error" | "skipped";
  readonly result?: JsonObject;
  readonly error?: string;
}

export interface WordPressVariationAutoSyncState {
  readonly runId: EntityId;
  readonly window: number;
  readonly acknowledgedFailedCount: number;
  readonly activeCount: number;
  readonly failedCount: number;
  readonly intervalMinutes: number;
  readonly cycle: number;
  readonly nextCycleAt: string | null;
}

export interface WordPressCatalogRunRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly targetName: string;
  readonly sourceCode: string;
  readonly status: WordPressCatalogRunStatus;
  readonly catalogCursor: string;
  readonly catalogComplete: boolean;
  readonly auditRequested: boolean;
  readonly variationSyncRequested: boolean;
  readonly variationAutoStatus: WordPressVariationAutoStatus;
  readonly variationAutoWindow: number;
  readonly variationAutoAcknowledgedFailedCount: number;
  readonly variationAutoError: string | null;
  readonly variationAutoStartedAt: string | null;
  readonly variationAutoCompletedAt: string | null;
  readonly variationSyncIntervalMinutes: number;
  readonly variationSyncCycle: number;
  readonly variationSyncLastCycleStartedAt: string | null;
  readonly variationSyncLastCycleCompletedAt: string | null;
  readonly variationSyncNextCycleAt: string | null;
  readonly actor: string;
  readonly reason: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly totalCount: number;
  readonly matchedCount: number;
  readonly unmatchedCount: number;
  readonly ambiguousCount: number;
  readonly variationPendingCount: number;
  readonly variationNotStartedCount: number;
  readonly variationSubmittedCount: number;
  readonly variationCompletedCount: number;
  readonly variationSkippedCount: number;
  readonly variationFailedCount: number;
  readonly auditPendingCount: number;
  readonly auditReadyCount: number;
  readonly auditBlockedCount: number;
  readonly auditErrorCount: number;
}

export interface WordPressCatalogPageInput {
  readonly wordpressProductId: string;
  readonly identity: JsonObject;
  readonly snapshot: JsonObject;
  readonly contentHash: string;
}

export interface WordPressCatalogRunItemSummaryRecord {
  readonly id: EntityId;
  readonly wordpressProductId: string;
  readonly sourceExternalId: string | null;
  readonly legacyGoatId: string | null;
  readonly sku: string | null;
  readonly sourceProductId: EntityId | null;
  readonly internalProductId: EntityId | null;
  readonly matchStatus: WordPressCatalogMatchStatus;
  readonly matchMethod: string | null;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly wordpressVariationCount: number;
  readonly wordpressImageCount: number;
  readonly auditStatus: string;
  readonly auditRisk: string | null;
  readonly auditError: string | null;
  readonly changeFlags: readonly string[];
  readonly variationStatus: string;
  readonly wordpressJobId: string | null;
  readonly variationError: string | null;
  readonly snapshotFetchedAt: string;
  readonly variationCheckedAt: string | null;
  readonly updatedAt: string;
}

export interface WordPressCatalogRunItemRecord {
  readonly id: EntityId;
  readonly runId: EntityId;
  readonly wordpressProductId: string;
  readonly sourceCode: string | null;
  readonly sourceExternalId: string | null;
  readonly legacyGoatId: string | null;
  readonly sku: string | null;
  readonly sourceProductId: EntityId | null;
  readonly internalProductId: EntityId | null;
  readonly matchStatus: WordPressCatalogMatchStatus;
  readonly matchMethod: string | null;
  readonly matchDetails: JsonObject;
  readonly auditStatus: string;
  readonly auditResult: JsonObject | null;
  readonly auditError: string | null;
  readonly variationStatus: string;
  readonly variationPayload: JsonObject | null;
  readonly variationNotices: readonly JsonObject[];
  readonly wordpressJobId: string | null;
  readonly variationResult: JsonObject | null;
  readonly variationError: string | null;
  readonly variationSourceHash: string | null;
  readonly variationAppliedSourceHash: string | null;
  readonly variationSourceVariants: readonly ProductVariantDTO[];
  readonly variationSyncCycle: number;
  readonly payload: JsonObject;
  readonly targetTermLabels?: JsonObject;
  readonly proposedImages?: readonly JsonObject[];
  readonly fetchedAt: string;
  readonly variationCheckedAt: string | null;
  readonly updatedAt: string;
}

export interface WordPressCatalogVariationCandidate {
  readonly item: WordPressCatalogRunItemRecord;
  readonly source: SourceDTO;
  readonly sourceProduct: SourceProductDTO;
  readonly target: TargetDTO;
  readonly product: UniversalProductDTO;
  readonly internalContentHash: string;
}

export interface WordPressCatalogRepository {
  createRun(input: {
    readonly targetId: EntityId;
    readonly sourceCode: string;
    readonly auditRequested: boolean;
    readonly variationSyncRequested: boolean;
    readonly actor: string;
    readonly reason?: string;
  }): Promise<WordPressCatalogRunRecord>;
  getRun(runId: EntityId): Promise<WordPressCatalogRunRecord | null>;
  listRuns(targetId: EntityId, limit: number): Promise<readonly WordPressCatalogRunRecord[]>;
  listItems(input: {
    readonly runId: EntityId;
    readonly search?: string;
    readonly matchStatus?: WordPressCatalogMatchStatus;
    readonly auditStatus?: WordPressCatalogAuditFilter;
    readonly risk?: WordPressCatalogRiskFilter;
    readonly operation?: WordPressCatalogOperationFilter;
    readonly changeFlag?: string;
    readonly variationFilter?: WordPressCatalogVariationFilter;
    readonly limit: number;
    readonly offset: number;
  }): Promise<{ readonly items: readonly WordPressCatalogRunItemSummaryRecord[]; readonly total: number }>;
  getItem(runId: EntityId, itemId: EntityId): Promise<WordPressCatalogRunItemRecord | null>;
  savePage(input: {
    readonly runId: EntityId;
    readonly expectedCursor: string;
    readonly nextCursor: string;
    readonly hasMore: boolean;
    readonly fetchedAt: string;
    readonly items: readonly WordPressCatalogPageInput[];
  }): Promise<WordPressCatalogRunRecord>;
  failRun(runId: EntityId, error: string): Promise<void>;
  listVariationCandidates(input: {
    readonly runId: EntityId;
    readonly afterWordPressProductId: string;
    readonly throughWordPressProductId: string;
  }): Promise<readonly WordPressCatalogVariationCandidate[]>;
  saveVariationPreparation(input: {
    readonly itemId: EntityId;
    readonly status: "ready" | "skipped" | "failed";
    readonly payload?: JsonObject;
    readonly notices: readonly JsonObject[];
    readonly error?: string;
  }): Promise<void>;
  saveVariationSource(input: {
    readonly runId: EntityId;
    readonly itemId: EntityId;
    readonly wordpressProductId: string;
    readonly sourceHash: string;
    readonly variants: readonly ProductVariantDTO[];
    readonly unchanged: boolean;
  }): Promise<void>;
  listVariationSubmissionItems(runId: EntityId, itemIds: readonly EntityId[]): Promise<readonly WordPressCatalogRunItemRecord[]>;
  saveVariationSubmission(input: {
    readonly itemId: EntityId;
    readonly wordpressJobId: string;
    readonly result: JsonObject;
  }): Promise<void>;
  listSubmittedVariationItems(runId: EntityId, wordpressJobIds: readonly string[]): Promise<readonly WordPressCatalogRunItemRecord[]>;
  saveVariationJobResult(input: {
    readonly itemId: EntityId;
    readonly status: "completed" | "failed";
    readonly result: JsonObject;
    readonly error?: string;
  }): Promise<void>;
  saveAudit(input: WordPressCatalogAuditSaveInput): Promise<void>;
  saveAudits(inputs: readonly WordPressCatalogAuditSaveInput[]): Promise<void>;
  retryBlockedAudits(runId: EntityId): Promise<{ readonly queuedItemCount: number; readonly queuedJobCount: number }>;
  rebuildAudits(runId: EntityId, changeFlag?: string): Promise<{ readonly queuedItemCount: number; readonly queuedJobCount: number }>;
  enqueueVariationItems(runId: EntityId, itemIds: readonly EntityId[]): Promise<number>;
  enqueueReadyVariationBatches(runId: EntityId, batchSize: number): Promise<number>;
  failVariationItems(runId: EntityId, itemIds: readonly EntityId[], error: string): Promise<void>;
  getActiveVariationSync(): Promise<WordPressVariationAutoSyncState | null>;
  replenishVariationAutoSync(): Promise<WordPressVariationAutoTickOutcome>;
  startVariationAutoSync(runId: EntityId, window: number, intervalMinutes: number): Promise<void>;
  setVariationAutoSyncStatus(input: {
    readonly runId: EntityId;
    readonly status: "running" | "paused" | "inactive";
    readonly error?: string;
    readonly acknowledgeFailures?: number;
  }): Promise<void>;
}
