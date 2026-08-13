import type { EntityId, JsonObject, SourceDTO, SourceProductDTO, TargetDTO, UniversalProductDTO } from "../contracts/index.js";

export type WordPressCatalogRunStatus = "running" | "paused" | "completed" | "failed";
export type WordPressCatalogMatchStatus = "matched" | "unmatched" | "ambiguous";

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
  readonly payload: JsonObject;
  readonly fetchedAt: string;
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
    readonly matchStatus?: WordPressCatalogMatchStatus;
    readonly limit: number;
    readonly offset: number;
  }): Promise<{ readonly items: readonly WordPressCatalogRunItemRecord[]; readonly total: number }>;
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
  saveAudit(input: {
    readonly itemId: EntityId;
    readonly status: "ready" | "blocked" | "error" | "skipped";
    readonly result?: JsonObject;
    readonly error?: string;
  }): Promise<void>;
  enqueueVariationItems(runId: EntityId, itemIds: readonly EntityId[]): Promise<number>;
  enableVariationSync(runId: EntityId): Promise<number>;
}
