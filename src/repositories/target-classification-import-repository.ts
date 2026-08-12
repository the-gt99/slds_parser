import type { EntityId, JsonObject } from "../contracts/index.js";

export type TargetClassificationSyncStatus = "pending" | "running" | "completed" | "failed";
export type TargetClassificationSuggestionStatus = "ready" | "conflict" | "applied";

export interface TargetClassificationSyncRun {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly targetCode: string;
  readonly targetName: string;
  readonly targetEnabled: boolean;
  readonly sourceId: EntityId;
  readonly sourceCode: string;
  readonly sourceName: string;
  readonly status: TargetClassificationSyncStatus;
  readonly cursor: string;
  readonly fetchedProductCount: number;
  readonly matchedSourceProductCount: number;
  readonly assignmentCount: number;
  readonly suggestionCount: number;
  readonly readySuggestionCount: number;
  readonly conflictSuggestionCount: number;
  readonly requestedBy: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TargetClassificationImportProductInput {
  readonly targetExternalId: string;
  readonly sourceExternalId: string;
  readonly taxonomies: JsonObject;
}

export interface TargetClassificationSuggestionTarget {
  readonly dictionaryValueId: EntityId | null;
  readonly externalValue: string;
  readonly name: string;
  readonly productCount: number;
}

export interface TargetClassificationSuggestion {
  readonly id: EntityId;
  readonly runId: EntityId;
  readonly targetId: EntityId;
  readonly sourceId: EntityId;
  readonly typeCode: string;
  readonly suggestionKind: "mapping" | "rule";
  readonly scope: string;
  readonly normalizedSourceValue: string;
  readonly contextKey: string;
  readonly context: JsonObject;
  readonly sourceValue: string;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId | null;
  readonly externalValue: string | null;
  readonly targetName: string | null;
  readonly matchedProductCount: number;
  readonly evidenceProductCount: number;
  readonly missingTargetCount: number;
  readonly targets: readonly TargetClassificationSuggestionTarget[];
  readonly status: TargetClassificationSuggestionStatus;
  readonly issueReason: string | null;
  readonly appliedResolutionKind: "mapping" | "rule" | null;
  readonly appliedResolutionId: EntityId | null;
}

export interface TargetClassificationSuggestionQuery {
  readonly targetId: EntityId;
  readonly sourceId: EntityId;
  readonly typeCode?: string;
  readonly status?: TargetClassificationSuggestionStatus;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface TargetClassificationSuggestionResult {
  readonly items: readonly TargetClassificationSuggestion[];
  readonly total: number;
  readonly summary: {
    readonly readyCount: number;
    readonly readyProductCount: number;
    readonly conflictCount: number;
    readonly appliedCount: number;
  };
  readonly latestCompletedRun: TargetClassificationSyncRun | null;
  readonly activeRun: TargetClassificationSyncRun | null;
}

export interface TargetClassificationImportRepository {
  createRun(targetId: EntityId, sourceId: EntityId, actor: string): Promise<TargetClassificationSyncRun>;
  getRun(runId: EntityId): Promise<TargetClassificationSyncRun | null>;
  savePage(input: {
    readonly runId: EntityId;
    readonly cursor: string;
    readonly nextCursor: string;
    readonly hasMore: boolean;
    readonly items: readonly TargetClassificationImportProductInput[];
  }): Promise<void>;
  failRun(runId: EntityId, error: string): Promise<void>;
  listSuggestions(query: TargetClassificationSuggestionQuery): Promise<TargetClassificationSuggestionResult>;
  getReadySuggestions(runId: EntityId, suggestionIds: readonly EntityId[]): Promise<readonly TargetClassificationSuggestion[]>;
  markApplied(suggestionId: EntityId, resolutionKind: "mapping" | "rule", resolutionId: EntityId, actor: string): Promise<void>;
}
