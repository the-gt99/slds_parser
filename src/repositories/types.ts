import type {
  ClassificationIssueReason,
  DiscoveryCompleteness,
  EntityId,
  JsonObject,
  JsonValue,
  ReferenceCandidateDTO,
  ReferenceResolutionKind,
  UniversalProductDTO,
} from "../contracts/index.js";

export type Timestamp = string;
export type SourceRunStatus = "running" | "completed" | "failed";
export type MappingStatus = "confirmed" | "suggested" | "rejected";
export type JobType =
  | "discover_source"
  | "collect_product"
  | "process_product"
  | "reclassify_product"
  | "sync_target_classifications"
  | "apply_target_classification_suggestion"
  | "preflight_product"
  | "sync_wordpress_catalog"
  | "prepare_wordpress_variation_patches"
  | "refresh_wordpress_variation_patch"
  | "poll_wordpress_variation_patches"
  | "export_product";
export type JobStatus = "pending" | "running" | "retry" | "completed" | "failed";

export interface SourceRecord {
  readonly id: EntityId;
  readonly code: string;
  readonly name: string;
  readonly adapterCode: string;
  readonly config: JsonObject;
  readonly enabled: boolean;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface SourceRunRecord {
  readonly id: EntityId;
  readonly sourceId: EntityId;
  readonly runType: string;
  readonly coverage: string;
  readonly status: SourceRunStatus;
  readonly completeness: DiscoveryCompleteness;
  readonly checkpoint: JsonValue;
  readonly processedCount: string;
  readonly discoveredCount: string;
  readonly errorCount: string;
  readonly startedAt: Timestamp;
  readonly finishedAt: Timestamp | null;
  readonly lastError: string | null;
}

export interface CreateSourceRunInput {
  readonly sourceId: EntityId;
  readonly runType: string;
  readonly coverage: string;
  readonly checkpoint: JsonValue;
}

export interface RecordSourceRunPageInput {
  readonly checkpoint: JsonValue;
  readonly processedCount: string;
  readonly discoveredCount: string;
  readonly errorCount: string;
  readonly completeness: DiscoveryCompleteness;
}

export interface CompleteSourceRunInput {
  readonly checkpoint: JsonValue;
  readonly completeness: DiscoveryCompleteness;
  readonly finishedAt: Timestamp;
}

export interface FailSourceRunInput {
  readonly error: string;
  readonly checkpoint: JsonValue;
  readonly finishedAt: Timestamp;
}

export interface SourceProductRecord {
  readonly id: EntityId;
  readonly sourceId: EntityId;
  readonly sourceKey: string;
  readonly externalId: string | null;
  readonly slug: string | null;
  readonly url: string | null;
  readonly discoveryMetadata: JsonObject;
  readonly status: string;
  readonly firstSeenAt: Timestamp;
  readonly lastSeenAt: Timestamp;
  readonly lastSeenRunId: EntityId | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface SourceProductCollectionCandidate {
  readonly id: EntityId;
  readonly sourceKey: string;
  readonly route: string;
}

export interface SourceProductCollectionCandidateQuery {
  readonly sourceId: EntityId;
  readonly limit: number;
  readonly seed: number;
  readonly routes?: readonly string[];
  readonly sourceProductIds?: readonly EntityId[];
}

export interface UpsertDiscoveredSourceProductInput {
  readonly sourceId: EntityId;
  readonly sourceKey: string;
  readonly externalId?: string | null;
  readonly slug?: string | null;
  readonly url?: string | null;
  readonly discoveryMetadata: JsonObject;
  readonly status: string;
  readonly seenAt: Timestamp;
  readonly runId: EntityId;
}

export interface UpdateSourceProductIdentityInput {
  readonly externalId?: string | null;
  readonly slug?: string | null;
  readonly url?: string | null;
}

export interface SourceProductPartRecord {
  readonly id: EntityId;
  readonly sourceProductId: EntityId;
  readonly partKey: string;
  readonly rawPayload: JsonValue;
  readonly parsedPayload: JsonValue;
  readonly contentHash: string;
  readonly sourceUpdatedAt: Timestamp | null;
  readonly fetchedAt: Timestamp;
  readonly adapterVersion: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface UpsertSourceProductPartInput {
  readonly sourceProductId: EntityId;
  readonly partKey: string;
  readonly rawPayload: JsonValue;
  readonly parsedPayload: JsonValue;
  readonly contentHash: string;
  readonly sourceUpdatedAt?: Timestamp | null;
  readonly fetchedAt: Timestamp;
  readonly adapterVersion: string;
}

export interface UpsertSourceProductPartResult {
  readonly part: SourceProductPartRecord;
  readonly changed: boolean;
}

export interface InternalProductRecord {
  readonly id: EntityId;
  readonly sourceProductId: EntityId;
  readonly data: UniversalProductDTO;
  readonly inputHash: string;
  readonly contentHash: string;
  readonly processorVersion: string;
  readonly status: string;
  readonly processedAt: Timestamp | null;
  readonly lastError: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface UpsertInternalProductInput {
  readonly sourceProductId: EntityId;
  readonly data: UniversalProductDTO;
  readonly inputHash: string;
  readonly contentHash: string;
  readonly processorVersion: string;
  readonly status: string;
  readonly processedAt?: Timestamp | null;
  readonly lastError?: string | null;
}

export interface ReferenceValueRecord {
  readonly id: EntityId;
  readonly typeId: EntityId;
  readonly code: string;
  readonly name: string;
  readonly parentId: EntityId | null;
  readonly metadata: JsonObject;
  readonly enabled: boolean;
}

export interface ClassificationReferenceTypeRecord {
  readonly code: string;
  readonly cardinality: "single" | "multiple";
  readonly allowedSubjectKinds: readonly ("product" | "variant")[];
  readonly metadata: JsonObject;
}

export interface ClassificationLookupInput {
  readonly candidateKey: string;
  readonly typeCode: string;
  readonly scope: string;
  readonly normalizedSourceValue: string;
  readonly contextKey: string;
}

export interface ClassificationMappingMatchRecord {
  readonly candidateKey: string;
  readonly mappingId: EntityId;
  readonly referenceValueId: EntityId | null;
  readonly status: "confirmed" | "ignored";
  readonly revision: string;
}

export type ClassificationRuleOperator =
  | "equals"
  | "contains"
  | "all_words"
  | "regex";

export interface ClassificationRuleConditionRecord {
  readonly field: string;
  readonly operator: ClassificationRuleOperator;
  readonly value: string;
}

export interface ClassificationRuleRecord {
  readonly id: EntityId;
  readonly sourceId: EntityId;
  readonly typeCode: string;
  readonly name: string;
  readonly priority: number;
  readonly conditions: readonly ClassificationRuleConditionRecord[];
  readonly referenceValueId: EntityId;
  readonly revision: string;
}

export interface ProductClassificationObservationInput {
  readonly candidate: ReferenceCandidateDTO;
  readonly normalizedSourceValue: string;
  readonly contextKey: string;
  readonly status: "resolved" | "ignored" | "unresolved" | "ambiguous";
  readonly issueReason: ClassificationIssueReason | null;
  readonly referenceValueId: EntityId | null;
  readonly resolutionKind: ReferenceResolutionKind | null;
  readonly resolutionId: EntityId | null;
  readonly resolutionRevision: string | null;
  readonly matchedRuleIds?: readonly EntityId[];
}

export interface SaveProductClassificationInput {
  readonly sourceId: EntityId;
  readonly sourceProductId: EntityId;
  readonly processorVersion: string;
  readonly classifierVersion: string;
  readonly fingerprint: string;
  readonly observations: readonly ProductClassificationObservationInput[];
}

export interface TargetValueMappingRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly referenceValueId: EntityId;
  readonly targetScope: string;
  readonly externalValue: string;
  readonly externalLabel: string;
  readonly metadata: JsonObject;
}

export interface TargetClassificationProjectionRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly resolutionKind: ReferenceResolutionKind;
  readonly resolutionId: EntityId;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly externalValue: string;
  readonly externalLabel: string;
  readonly externalSlug: string | null;
  readonly metadata: JsonObject;
  readonly revision: string;
  readonly active?: boolean;
  readonly createdAt?: Timestamp;
  readonly updatedAt?: Timestamp;
}

export interface TargetClassificationProjectionPreviewExample {
  readonly sourceProductId: EntityId;
  readonly sourceKey: string;
  readonly title: string | null;
  readonly sku: string | null;
  readonly currentTerms: readonly string[];
}

export interface TargetClassificationProjectionPreview {
  readonly observationCount: number;
  readonly productCount: number;
  readonly affectedSourceProductIds: readonly EntityId[];
  readonly examples: readonly TargetClassificationProjectionPreviewExample[];
  readonly duplicate: TargetClassificationProjectionRecord | TargetReferenceProjectionRecord | null;
  readonly cardinalityConflicts: readonly EntityId[];
}

export interface SaveTargetClassificationProjectionInput {
  readonly targetId: EntityId;
  readonly resolutionKind: ReferenceResolutionKind;
  readonly resolutionId: EntityId;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly actor: string;
  readonly reason?: string;
}

export interface TargetClassificationProjectionCommand {
  readonly targetId: EntityId;
  readonly resolutionKind: ReferenceResolutionKind;
  readonly resolutionId: EntityId;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly targetCardinality: "single" | "multiple";
  readonly excludeProjectionId?: EntityId;
  readonly actor: string;
  readonly reason?: string;
}

export interface TargetRecord {
  readonly id: EntityId;
  readonly code: string;
  readonly name: string;
  readonly exporterCode: string;
  readonly config: JsonObject;
  readonly enabled: boolean;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export type TargetContentTemplateField = "description" | "short_description";
export type TargetContentTemplateStatus = "draft" | "active" | "archived";
export type TargetContentTemplateManagementMode = "manage" | "preserve";

export interface TargetContentTemplateRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly field: TargetContentTemplateField;
  readonly name: string;
  readonly templateSource: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly managementMode: TargetContentTemplateManagementMode;
  readonly categoryTermIds: readonly number[];
  readonly requiredContextPaths: readonly string[];
  readonly preserveExistingStory: boolean;
  readonly status: TargetContentTemplateStatus;
  readonly revision: number;
  readonly actor: string;
  readonly createdAt: Timestamp;
  readonly activatedAt: Timestamp | null;
}

export interface CreateTargetContentTemplateDraftInput {
  readonly targetId: EntityId;
  readonly field: TargetContentTemplateField;
  readonly name: string;
  readonly templateSource: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly managementMode: TargetContentTemplateManagementMode;
  readonly categoryTermIds: readonly number[];
  readonly requiredContextPaths: readonly string[];
  readonly preserveExistingStory?: boolean;
  readonly actor: string;
}

export interface TargetProductRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly internalProductId: EntityId;
  readonly externalId: string | null;
  readonly status: string;
  readonly lastExportedHash: string | null;
  readonly lastExportFingerprint: string | null;
  readonly lastAttemptAt: Timestamp | null;
  readonly syncedAt: Timestamp | null;
  readonly lastError: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface TargetProductSnapshotRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly sourceProductId: EntityId;
  readonly externalId: string;
  readonly sourceExternalId: string;
  readonly payload: JsonObject;
  readonly contentHash: string;
  readonly fetchedAt: Timestamp;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface SaveTargetProductSnapshotInput {
  readonly targetId: EntityId;
  readonly sourceProductId: EntityId;
  readonly externalId: string;
  readonly sourceExternalId: string;
  readonly payload: JsonObject;
  readonly contentHash: string;
  readonly fetchedAt: Timestamp;
}

export interface SaveExportSuccessInput {
  readonly targetId: EntityId;
  readonly internalProductId: EntityId;
  readonly externalId: string;
  readonly status: string;
  readonly exportedHash: string;
  readonly exportFingerprint: string;
  readonly attemptedAt: Timestamp;
  readonly syncedAt: Timestamp;
}

export interface SaveExportFailureInput {
  readonly targetId: EntityId;
  readonly internalProductId: EntityId;
  readonly status: string;
  readonly error: string;
  readonly attemptedAt: Timestamp;
}

export interface JobRecord {
  readonly id: EntityId;
  readonly jobType: JobType;
  readonly payload: JsonValue;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly availableAt: Timestamp;
  readonly lockedAt: Timestamp | null;
  readonly lockedBy: string | null;
  readonly uniqueKey: string;
  readonly lastError: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly finishedAt: Timestamp | null;
}

export type ProductOperationExecutionStatus = "running" | "completed" | "failed";

export interface ProductOperationExecutionRecord {
  readonly id: EntityId;
  readonly attemptId: string;
  readonly sourceProductId: EntityId;
  readonly operationCode: string;
  readonly operationName: string;
  readonly operationVersion: string;
  readonly sequence: number;
  readonly status: ProductOperationExecutionStatus;
  readonly startedAt: Timestamp;
  readonly finishedAt: Timestamp | null;
  readonly error: string | null;
  readonly outputData: UniversalProductDTO | null;
}

export interface StartProductOperationExecutionInput {
  readonly attemptId: string;
  readonly sourceProductId: EntityId;
  readonly operationCode: string;
  readonly operationName: string;
  readonly operationVersion: string;
  readonly sequence: number;
  readonly startedAt: Timestamp;
}

export interface ProductPartSummaryRecord {
  readonly id: EntityId;
  readonly partKey: string;
  readonly contentHash: string;
  readonly sourceUpdatedAt: Timestamp | null;
  readonly fetchedAt: Timestamp;
  readonly adapterVersion: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly rawPayload: JsonValue;
  readonly parsedPayload: JsonValue;
}

export interface ProductProcessingAttemptRecord {
  readonly attemptId: string;
  readonly sourceProductId: EntityId;
  readonly processorVersion: string;
  readonly status: ProductOperationExecutionStatus;
  readonly processorOutput: UniversalProductDTO;
  readonly operationsOutput: UniversalProductDTO | null;
  readonly classifiedOutput: UniversalProductDTO | null;
  readonly startedAt: Timestamp;
  readonly finishedAt: Timestamp | null;
  readonly error: string | null;
}

export interface ProductSnapshotListItem {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly targetCode: string;
  readonly targetName: string;
  readonly sourceProductId: EntityId;
  readonly sourceCode: string;
  readonly sourceExternalId: string;
  readonly externalId: string;
  readonly title: string | null;
  readonly fetchedAt: Timestamp;
  readonly payload: JsonObject;
}

export interface ProductListItem {
  readonly sourceProductId: EntityId;
  readonly sourceId: EntityId;
  readonly sourceCode: string;
  readonly sourceName: string;
  readonly sourceKey: string;
  readonly externalId: string | null;
  readonly title: string | null;
  readonly sourceStatus: string;
  readonly stage: string;
  readonly classificationStatus: string;
  readonly collectedAt: Timestamp | null;
  readonly processedAt: Timestamp | null;
  readonly targetStatus: string;
  readonly targetJobStatus: JobStatus | null;
  readonly targetExternalId: string | null;
  readonly hasTargetSnapshot: boolean;
}

export interface ProductListQuery {
  readonly search?: string;
  readonly sourceCode?: string;
  readonly stage?: string;
  readonly classificationStatus?: string;
  readonly targetStatus?: string;
  readonly limit: number;
  readonly offset: number;
}

export type ProductBatchAction =
  | "collect"
  | "collect_and_process"
  | "process"
  | "reprocess"
  | "retry_failed_processing"
  | "export";

export interface ProductBatchFilter extends Omit<ProductListQuery, "limit" | "offset"> {
  readonly selectedIds?: readonly EntityId[];
  readonly limit: number;
  readonly includeFailedProcessing?: boolean;
}

export interface ProductBatchCandidate {
  readonly sourceProductId: EntityId;
  readonly internalProductId: EntityId | null;
  readonly stage: string;
  readonly imageCount: number;
  readonly activeCollectJobId: EntityId | null;
  readonly activeProcessJobId: EntityId | null;
  readonly failedProcessJobId: EntityId | null;
}

export interface ProductBatchDryRunInput {
  readonly action: ProductBatchAction;
  readonly filter: ProductBatchFilter;
  readonly force: boolean;
}

export interface ProductBatchSkipReason {
  readonly reason: string;
  readonly count: number;
}

export interface ProductBatchDryRun {
  readonly action: ProductBatchAction;
  readonly selectedCount: number;
  readonly eligibleCount: number;
  readonly skippedCount: number;
  readonly activeDuplicateCount: number;
  readonly jobsToCreate: number;
  readonly force: boolean;
  readonly enqueueProcessing: boolean | null;
  readonly skipReasons: readonly ProductBatchSkipReason[];
  readonly sampleProductIds: readonly EntityId[];
  readonly estimatedImages: number;
  readonly disk: { readonly availableBytes: number | null; readonly warning: string | null };
}

export interface ProductBatchApplyResult extends ProductBatchDryRun {
  readonly auditId: EntityId | null;
  readonly createdJobIds: readonly EntityId[];
}

export interface ProductBatchAuditInput {
  readonly action: ProductBatchAction;
  readonly filter: ProductBatchFilter;
  readonly dryRun: ProductBatchDryRun;
  readonly createdJobIds: readonly EntityId[];
  readonly actor: string;
  readonly reason?: string;
}

export interface ProductListResult {
  readonly items: readonly ProductListItem[];
  readonly total: number;
  readonly sources: readonly { readonly code: string; readonly name: string }[];
}

export interface ProductSnapshotListQuery {
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface ProductSnapshotListResult {
  readonly items: readonly ProductSnapshotListItem[];
  readonly total: number;
}

export interface ProductClassificationObservationRecord {
  readonly id: EntityId;
  readonly candidateKey: string;
  readonly typeCode: string;
  readonly typeName: string;
  readonly scope: string;
  readonly sourceValue: string;
  readonly normalizedSourceValue: string;
  readonly contextKey: string;
  readonly context: JsonObject;
  readonly evidence: JsonObject;
  readonly status: "resolved" | "ignored" | "unresolved" | "ambiguous";
  readonly issueReason: ClassificationIssueReason | null;
  readonly resolvedReferenceValueId: EntityId | null;
  readonly resolvedReferenceName: string | null;
  readonly resolutionKind: "mapping" | "rule" | null;
  readonly resolutionId: EntityId | null;
  readonly outputs: readonly ClassificationConfigOutput[];
  readonly firstSeenAt: Timestamp;
  readonly lastSeenAt: Timestamp;
}

export interface ProductTargetSnapshotRecord {
  readonly target: TargetRecord;
  readonly product: TargetProductRecord | null;
}

export interface ProductAdminReadModel {
  readonly source: SourceRecord;
  readonly sourceProduct: SourceProductRecord;
  readonly lastCollectionRun: SourceRunRecord | null;
  readonly internalProduct: InternalProductRecord | null;
  readonly parts: readonly ProductPartSummaryRecord[];
  readonly operations: readonly ProductOperationExecutionRecord[];
  readonly processingAttempts?: readonly ProductProcessingAttemptRecord[];
  readonly classifications: readonly ProductClassificationObservationRecord[];
  readonly jobs: readonly JobRecord[];
  readonly targets: readonly ProductTargetSnapshotRecord[];
  readonly snapshots?: readonly ProductSnapshotListItem[];
}

export interface JobAdminListQuery {
  readonly jobType?: JobType;
  readonly status?: JobStatus;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface JobAdminListItem {
  readonly id: EntityId;
  readonly jobType: JobType;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly createdAt: Timestamp;
  readonly availableAt: Timestamp;
  readonly startedAt: Timestamp | null;
  readonly lockedAt: Timestamp | null;
  readonly lockedBy: string | null;
  readonly updatedAt: Timestamp;
  readonly finishedAt: Timestamp | null;
  readonly queueWaitMs: number | null;
  readonly durationMs: number | null;
  readonly sourceProductId: EntityId | null;
  readonly lastError: string | null;
  readonly payload: JsonValue;
}

export interface JobAdminTypeSummary {
  readonly jobType: JobType;
  readonly remaining: number;
  readonly completion: { readonly last15m: number; readonly last1h: number; readonly last24h: number };
  readonly concurrency: number;
  readonly estimatedDurationMs: number | null;
  readonly etaBasis: "duration" | "throughput" | null;
  readonly etaMinutes: number | null;
}

export interface JobAdminSummary {
  readonly byStatus: readonly { readonly status: JobStatus; readonly count: number }[];
  readonly byTypeStatus: readonly { readonly jobType: JobType; readonly status: JobStatus; readonly count: number }[];
  readonly errorGroups: readonly { readonly jobType: JobType; readonly message: string; readonly count: number; readonly latestAt: Timestamp }[];
  readonly byJobType: readonly JobAdminTypeSummary[];
}

export interface JobAdminListResult {
  readonly total: number;
  readonly items: readonly JobAdminListItem[];
  readonly summary: JobAdminSummary;
}

export interface FailedJobRetryPreview {
  readonly jobType: JobType;
  readonly failedCount: number;
  readonly limitedCount: number;
  readonly activeDuplicateCount: number;
  readonly retryCount: number;
  readonly sampleJobIds: readonly EntityId[];
}

export interface EnqueueJobInput {
  readonly jobType: JobType;
  readonly payload: JsonValue;
  readonly uniqueKey: string;
  readonly availableAt?: Timestamp;
}

export interface RetryJobInput {
  readonly error: string;
  readonly availableAt: Timestamp;
}

export type ClassificationReviewStatus = "unresolved" | "ambiguous" | "waiting_apply";

export interface ClassificationDecisionKey {
  readonly sourceId: EntityId;
  readonly typeCode: string;
  readonly scope: string;
  readonly normalizedSourceValue: string;
  readonly contextKey: string;
}

export interface ClassificationReviewExample {
  readonly observationId: EntityId;
  readonly sourceProductId: EntityId;
  readonly sourceKey: string;
  readonly title: string | null;
  readonly sku: string | null;
  readonly evidence: JsonObject;
  readonly targetSnapshots: readonly {
    readonly targetId: EntityId;
    readonly externalId: string;
    readonly snapshot: JsonObject;
  }[];
}

export type ExportControlStatus = "checking" | "ready" | "blocked" | "error" | "stale";
export type ExportControlRiskLevel = "none" | "review" | "danger";
export type ExportControlOperation = "create" | "update";

export interface ExportControlCursor {
  readonly checkedAt: Timestamp;
  readonly id: EntityId;
}

export interface ExportControlFilter {
  readonly status?: ExportControlStatus;
  readonly operation?: ExportControlOperation;
  readonly riskLevel?: ExportControlRiskLevel;
  readonly changeFlag?: string;
  readonly search?: string;
}

export interface ExportControlListQuery extends ExportControlFilter {
  readonly targetId: EntityId;
  readonly limit: number;
  readonly cursor?: ExportControlCursor;
}

export interface ExportControlListItem {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly targetName: string;
  readonly targetEnabled: boolean;
  readonly sourceProductId: EntityId;
  readonly internalProductId: EntityId;
  readonly sourceCode: string;
  readonly sourceExternalId: string | null;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly status: ExportControlStatus;
  readonly phase: string;
  readonly payloadHash: string | null;
  readonly externalId: string | null;
  readonly willCreate: boolean | null;
  readonly matchedBy: string | null;
  readonly riskLevel: ExportControlRiskLevel;
  readonly changeFlags: readonly string[];
  readonly fieldChangeCount: number;
  readonly taxonomyAddedCount: number;
  readonly taxonomyRemovedCount: number;
  readonly imageChangeCount: number;
  readonly variationChangeCount: number;
  readonly deactivatedVariationCount: number;
  readonly blockers: JsonValue;
  readonly changeSummary: JsonObject;
  readonly error: string | null;
  readonly checkedAt: Timestamp;
  readonly wordpressCheckedAt: Timestamp | null;
  readonly wordpressSnapshotFetchedAt: Timestamp | null;
  readonly usedCachedWordPress: boolean;
  readonly lastExportJob: {
    readonly id: EntityId;
    readonly status: JobStatus;
    readonly createdAt: Timestamp;
    readonly finishedAt: Timestamp | null;
    readonly lastError: string | null;
  } | null;
  readonly targetProductStatus: string | null;
  readonly targetProductExternalId: string | null;
}

export interface ExportControlListResult {
  readonly items: readonly ExportControlListItem[];
  readonly nextCursor: ExportControlCursor | null;
  readonly summary: ExportControlReadinessSummary;
}

export interface ExportControlReadinessSummary {
  readonly candidateCount: number;
  readonly reviewedCount: number;
  readonly unreviewedCount: number;
  readonly checkingCount: number;
  readonly readyCount: number;
  readonly exportableCount: number;
  readonly blockedCount: number;
  readonly staleCount: number;
  readonly errorCount: number;
}

export interface SaveExportControlPreflightInput {
  readonly targetId: EntityId;
  readonly internalProductId: EntityId;
  readonly sourceProductId: EntityId;
  readonly sourceCode: string;
  readonly sourceExternalId: string | null;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly status: Exclude<ExportControlStatus, "checking" | "stale">;
  readonly phase: string;
  readonly internalContentHash: string;
  readonly configurationRevision: string;
  readonly payloadHash: string | null;
  readonly externalId: string | null;
  readonly willCreate: boolean | null;
  readonly matchedBy: string | null;
  readonly riskLevel: ExportControlRiskLevel;
  readonly changeFlags: readonly string[];
  readonly fieldChangeCount: number;
  readonly taxonomyAddedCount: number;
  readonly taxonomyRemovedCount: number;
  readonly imageChangeCount: number;
  readonly variationChangeCount: number;
  readonly deactivatedVariationCount: number;
  readonly blockers: JsonValue;
  readonly changeSummary: JsonObject;
  readonly wordpressCheckedAt: Timestamp | null;
  readonly wordpressStateHash: string | null;
  readonly usedCachedWordPress: boolean;
  readonly preflightCache: JsonObject;
  readonly error?: string | null;
}

export interface ExportControlPreflightCandidate {
  readonly sourceProductId: EntityId;
  readonly internalProductId: EntityId;
  readonly refreshWordPress: boolean;
}

export interface CachedExportControlPreflight {
  readonly status: Exclude<ExportControlStatus, "checking" | "stale">;
  readonly externalId: string | null;
  readonly willCreate: boolean | null;
  readonly matchedBy: string | null;
  readonly wordpressCheckedAt: Timestamp | null;
  readonly wordpressStateHash: string | null;
  readonly preflightCache: JsonObject;
  readonly riskLevel: ExportControlRiskLevel;
  readonly changeFlags: readonly string[];
  readonly variationChangeCount: number;
  readonly deactivatedVariationCount: number;
  readonly changeSummary: JsonObject;
  readonly blockers: JsonValue;
}

export interface ExportControlExportCandidate {
  readonly reviewId: EntityId;
  readonly sourceProductId: EntityId;
  readonly internalProductId: EntityId;
  readonly payloadHash: string;
  readonly willCreate: boolean;
  readonly externalId: string | null;
  readonly matchedBy: string | null;
  readonly riskLevel: ExportControlRiskLevel;
  readonly changeFlags: readonly string[];
  readonly wordpressStateHash: string | null;
}

export interface ExportControlBatchRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly actor: string;
  readonly reason: string | null;
  readonly createdAt: Timestamp;
  readonly itemCount: number;
  readonly pendingCount: number;
  readonly runningCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly campaignId: EntityId | null;
}

export interface ExportControlBatchItemRecord {
  readonly id: EntityId;
  readonly sourceProductId: EntityId;
  readonly internalProductId: EntityId;
}

export type ExportCampaignStatus = "running" | "paused" | "completed";

export interface ExportCampaignRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly status: ExportCampaignStatus;
  readonly actor: string;
  readonly reason: string | null;
  readonly preflightWindow: number;
  readonly maxExports: number | null;
  readonly itemCount: number;
  readonly pendingCount: number;
  readonly runningCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly acknowledgedFailedCount: number;
  readonly activePreflightCount: number;
  readonly scanBeforeInternalProductId: EntityId | null;
  readonly scanComplete: boolean;
  readonly lastError: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly pausedAt: Timestamp | null;
  readonly completedAt: Timestamp | null;
}

export interface ExportCampaignItemRecord {
  readonly id: EntityId;
  readonly batchId: EntityId;
  readonly sourceProductId: EntityId;
  readonly internalProductId: EntityId;
  readonly title: string;
  readonly wordpressExternalId: string | null;
  readonly status: JobStatus;
  readonly createdAt: Timestamp;
  readonly finishedAt: Timestamp | null;
  readonly error: string | null;
}

export interface ClassificationReviewExamplesQuery {
  readonly reviewGroupId: EntityId;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
  readonly currentProcessorVersions?: Readonly<Record<EntityId, string>>;
}

export interface ClassificationReviewExamplesResult {
  readonly items: readonly ClassificationReviewExample[];
  readonly total: number;
}

export interface ClassificationReviewItem extends ClassificationDecisionKey {
  readonly reviewGroupId: EntityId;
  readonly sourceCode: string;
  readonly sourceName: string;
  readonly typeName: string;
  readonly sourceValue: string;
  readonly context: JsonObject;
  readonly status: ClassificationReviewStatus;
  readonly issueReason: ClassificationIssueReason | null;
  readonly observationCount: number;
  readonly productCount: number;
  readonly firstSeenAt: Timestamp;
  readonly lastSeenAt: Timestamp;
  readonly examples: readonly ClassificationReviewExample[];
}

export interface ClassificationReviewQuery {
  readonly sourceId?: EntityId;
  readonly typeCode?: string;
  readonly status?: ClassificationReviewStatus;
  readonly search?: string;
  readonly contextKey?: string;
  readonly limit: number;
  readonly offset: number;
  readonly currentProcessorVersions?: Readonly<Record<EntityId, string>>;
}

export interface ClassificationReferenceValueOption {
  readonly id: EntityId;
  readonly typeCode: string;
  readonly code: string;
  readonly name: string;
  readonly parentId: EntityId | null;
  readonly metadata: JsonObject;
}

export interface ClassificationDecisionTargetLink {
  readonly targetId: EntityId;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly relatedProjectionSyncs?: readonly TargetRelatedProjectionSync[];
}

export interface TargetRelatedProjectionSync {
  readonly relationCode: string;
  readonly sourceTargetScope: string;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId | null;
  readonly metadata: JsonObject;
}

export interface SaveClassificationDecisionInput extends ClassificationDecisionKey {
  readonly action: "confirm" | "ignore";
  readonly referenceValueId?: EntityId;
  readonly targetLink?: ClassificationDecisionTargetLink;
  readonly generatedReferenceCode?: string;
  readonly actor: string;
  readonly reason?: string;
}

export interface SaveClassificationDecisionResult {
  readonly mappingId: EntityId;
  readonly referenceValueId: EntityId | null;
  readonly revision: string;
  readonly affectedProductCount: number;
  readonly affectedExportCount: number;
}

export interface ClassificationRuleCandidateRecord {
  readonly observationId: EntityId;
  readonly sourceId: EntityId;
  readonly sourceProductId: EntityId;
  readonly sourceKey: string;
  readonly title: string | null;
  readonly sku: string | null;
  readonly mappingId: EntityId | null;
  readonly mappingReferenceValueId: EntityId | null;
  readonly candidate: ReferenceCandidateDTO;
}

export interface CreateClassificationRuleInput {
  readonly sourceId: EntityId;
  readonly typeCode: string;
  readonly name: string;
  readonly priority: number;
  readonly conditions: readonly ClassificationRuleConditionRecord[];
  readonly referenceValueId?: EntityId;
  readonly targetLink?: ClassificationDecisionTargetLink;
  readonly generatedReferenceCode?: string;
  readonly actor: string;
  readonly reason?: string;
  readonly affectedSourceProductIds: readonly EntityId[];
  readonly matchedObservationIds: readonly EntityId[];
}

export interface CreateClassificationRuleResult {
  readonly ruleId: EntityId;
  readonly referenceValueId: EntityId;
  readonly revision: string;
  readonly affectedProductCount: number;
}

export interface ClassificationDecisionContext extends ClassificationDecisionKey {
  readonly observationId: EntityId;
  readonly sourceCode: string;
  readonly sourceValue: string;
}

export type ClassificationConfigKind = "mapping" | "rule" | "target_mapping" | "projection";
export type ClassificationConfigStatus = "active" | "inactive" | "ignored";

export interface ClassificationConfigListQuery {
  readonly kind?: ClassificationConfigKind;
  readonly configId?: EntityId;
  readonly referenceValueId?: EntityId;
  readonly sourceId?: EntityId;
  readonly targetId?: EntityId;
  readonly typeCode?: string;
  readonly status?: ClassificationConfigStatus;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
  readonly includeUsage?: boolean;
  readonly currentProcessorVersions?: Readonly<Record<EntityId, string>>;
}

export type ClassificationExactMatchStatus = "ready" | "duplicate" | "conflict";
export type ClassificationExactMatchIssueReason = ClassificationIssueReason | "target_mapping_ambiguous";

export interface ClassificationExactMatchCapability {
  readonly typeCode: string;
  readonly entityType: string;
  readonly targetScope: string;
}

export interface ClassificationExactMatchTarget {
  readonly dictionaryValueId: EntityId;
  readonly externalId: string;
  readonly name: string;
  readonly slug: string | null;
  readonly taxonomy: string | null;
}

export interface ClassificationExactMatchItem {
  readonly reviewGroupId: EntityId;
  readonly sourceId: EntityId;
  readonly sourceCode: string;
  readonly sourceName: string;
  readonly typeCode: string;
  readonly typeName: string;
  readonly scope: string;
  readonly normalizedSourceValue: string;
  readonly contextKey: string;
  readonly sourceValue: string;
  readonly productCount: number;
  readonly observationCount: number;
  readonly targetScope: string;
  readonly matchStatus: ClassificationExactMatchStatus;
  readonly issueReason: ClassificationExactMatchIssueReason | null;
  readonly targets: readonly ClassificationExactMatchTarget[];
}

export interface ClassificationExactMatchSummary {
  readonly readyCount: number;
  readonly readyProductCount: number;
  readonly duplicateCount: number;
  readonly conflictCount: number;
}

export interface ClassificationExactMatchQuery {
  readonly targetId: EntityId;
  readonly capabilities: readonly ClassificationExactMatchCapability[];
  readonly sourceId?: EntityId;
  readonly typeCode?: string;
  readonly status?: ClassificationExactMatchStatus;
  readonly search?: string;
  readonly reviewGroupIds?: readonly EntityId[];
  readonly limit: number;
  readonly offset: number;
  readonly currentProcessorVersions?: Readonly<Record<EntityId, string>>;
}

export interface ClassificationExactMatchResult {
  readonly items: readonly ClassificationExactMatchItem[];
  readonly total: number;
  readonly summary: ClassificationExactMatchSummary;
}

export interface ClassificationReferenceCatalogItem extends ClassificationReferenceValueOption {
  readonly typeName: string;
  readonly productCount: number;
  readonly mappingCount: number;
  readonly ruleCount: number;
  readonly outputs: readonly {
    readonly kind: "primary" | "additional";
    readonly id: EntityId;
    readonly targetId: EntityId;
    readonly targetCode: string;
    readonly targetScope: string;
    readonly dictionaryValueId: EntityId;
    readonly externalId: string;
    readonly label: string;
    readonly taxonomy: string | null;
  }[];
}

export interface ClassificationReferenceCatalogQuery {
  readonly typeCode?: string;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface ClassificationReferenceCatalogResult {
  readonly items: readonly ClassificationReferenceCatalogItem[];
  readonly total: number;
}

export interface TargetReferenceProjectionRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly referenceValueId: EntityId;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly externalValue: string;
  readonly externalLabel: string;
  readonly externalSlug: string | null;
  readonly metadata: JsonObject;
  readonly revision: string;
  readonly active?: boolean;
  readonly createdAt?: Timestamp;
  readonly updatedAt?: Timestamp;
}

export interface TargetReferenceProjectionCommand {
  readonly targetId: EntityId;
  readonly referenceValueId: EntityId;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly targetCardinality: "single" | "multiple";
  readonly actor: string;
  readonly reason?: string;
}

export type TargetAssignmentConditionOperator = "equals" | "one_of";

export interface TargetAssignmentConditionRecord {
  readonly field: string;
  readonly operator: TargetAssignmentConditionOperator;
  readonly values: readonly string[];
}

export interface TargetAssignmentActionRecord {
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly externalValue: string;
  readonly externalLabel: string;
  readonly mode: "add" | "replace";
}

export interface TargetAssignmentRuleRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly name: string;
  readonly groupCode: string;
  readonly priority: number;
  readonly conditions: readonly TargetAssignmentConditionRecord[];
  readonly actions: readonly TargetAssignmentActionRecord[];
  readonly enabled: boolean;
  readonly revision: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface TargetAssignmentRuleDraft {
  readonly targetId: EntityId;
  readonly name: string;
  readonly groupCode: string;
  readonly priority: number;
  readonly conditions: readonly TargetAssignmentConditionRecord[];
  readonly actions: readonly {
    readonly targetScope: string;
    readonly dictionaryValueId: EntityId;
    readonly mode: "add" | "replace";
  }[];
}

export interface TargetAssignmentRulePreview {
  readonly productCount: number;
  readonly examples: readonly {
    readonly sourceProductId: EntityId;
    readonly title: string;
    readonly sku: string;
  }[];
  readonly conflicts?: readonly {
    readonly ruleId: EntityId;
    readonly ruleName: string;
    readonly productCount: number;
  }[];
}

export interface ClassificationConfigOutput {
  readonly kind: "target_mapping" | "projection";
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly targetCode: string;
  readonly targetScope: string;
  readonly targetExternalId: string;
  readonly targetLabel: string;
  readonly targetTaxonomy: string | null;
  readonly status: "active" | "inactive";
}

export interface ClassificationConfigHistoryRecord {
  readonly id: EntityId;
  readonly action: string;
  readonly previousValue: JsonObject | null;
  readonly newValue: JsonObject | null;
  readonly actor: string | null;
  readonly reason: string | null;
  readonly createdAt: Timestamp;
}

export interface ClassificationConfigListItem {
  readonly kind: ClassificationConfigKind;
  readonly id: EntityId;
  readonly sourceId: EntityId | null;
  readonly sourceCode: string | null;
  readonly targetId: EntityId | null;
  readonly targetCode: string | null;
  readonly typeCode: string | null;
  readonly typeName: string | null;
  readonly scope: string | null;
  readonly sourceValue: string | null;
  readonly normalizedSourceValue: string | null;
  readonly context: JsonObject;
  readonly contextKey: string | null;
  readonly referenceValueId: EntityId | null;
  readonly referenceName: string | null;
  readonly targetScope: string | null;
  readonly targetExternalId: string | null;
  readonly targetLabel: string | null;
  readonly targetTaxonomy: string | null;
  readonly targetDictionaryValueId: EntityId | null;
  readonly ruleName: string | null;
  readonly conditions: readonly ClassificationRuleConditionRecord[];
  readonly priority: number | null;
  readonly status: ClassificationConfigStatus;
  readonly revision: string;
  readonly actor: string | null;
  readonly reason: string | null;
  readonly affectedProductCount: number;
  readonly examples: readonly ClassificationReviewExample[];
  readonly outputs: readonly ClassificationConfigOutput[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface ClassificationRuleAdminRecord extends ClassificationRuleRecord {
  readonly enabled: boolean;
}

export interface ClassificationRuleConditionFieldOption {
  readonly field: string;
  readonly exampleValues: readonly string[];
}

export interface ClassificationDecisionPreview {
  readonly observationCount: number;
  readonly productCount: number;
  readonly currentReferenceValueId: EntityId | null;
  readonly proposedReferenceValueId: EntityId | null;
  readonly currentStatus: "confirmed" | "ignored" | null;
  readonly proposedStatus: "confirmed" | "ignored";
  readonly unchanged: boolean;
  readonly examples: readonly ClassificationReviewExample[];
}

export interface TargetValueMappingAdminRecord extends TargetValueMappingRecord {
  readonly dictionaryValueId: EntityId | null;
  readonly active: boolean;
  readonly revision: string;
  readonly typeCode: string;
}

export interface TargetValueMappingCommand {
  readonly mappingId: EntityId;
  readonly dictionaryValueId: EntityId;
  readonly relatedProjectionSyncs?: readonly TargetRelatedProjectionSync[];
  readonly actor: string;
  readonly reason?: string;
}

export interface CreateTargetValueMappingCommand {
  readonly targetId: EntityId;
  readonly referenceValueId: EntityId;
  readonly typeCode: string;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly relatedProjectionSyncs?: readonly TargetRelatedProjectionSync[];
  readonly targetCardinality: "single" | "multiple";
  readonly actor: string;
  readonly reason?: string;
}

export interface ClassificationConfigListResult {
  readonly items: readonly ClassificationConfigListItem[];
  readonly total: number;
  readonly sources: readonly { readonly id: EntityId; readonly code: string; readonly name: string }[];
  readonly targets: readonly { readonly id: EntityId; readonly code: string; readonly name: string }[];
  readonly types: readonly { readonly code: string; readonly name: string }[];
}

export interface UpdateClassificationRuleInput {
  readonly ruleId: EntityId;
  readonly name: string;
  readonly priority: number;
  readonly conditions: readonly ClassificationRuleConditionRecord[];
  readonly referenceValueId: EntityId;
  readonly actor: string;
  readonly reason?: string;
  readonly affectedSourceProductIds: readonly EntityId[];
  readonly matchedObservationIds: readonly EntityId[];
}

export interface UpdateClassificationRuleResult {
  readonly ruleId: EntityId;
  readonly revision: string;
  readonly affectedProductCount: number;
}

export interface TargetDictionaryValueRecord {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly entityType: string;
  readonly externalId: string;
  readonly name: string;
  readonly slug: string | null;
  readonly parentExternalId: string | null;
  readonly taxonomy: string | null;
  readonly attributeCode: string | null;
  readonly remoteUpdatedAt: Timestamp | null;
  readonly syncCursor: string | null;
  readonly metadata: JsonObject;
  readonly active: boolean;
  readonly firstSeenAt: Timestamp;
  readonly lastSeenAt: Timestamp;
}

export interface TargetDictionaryValueInput {
  readonly externalId: string;
  readonly name: string;
  readonly slug?: string | null;
  readonly parentExternalId?: string | null;
  readonly taxonomy?: string | null;
  readonly attributeCode?: string | null;
  readonly remoteUpdatedAt?: Timestamp | null;
  readonly syncCursor?: string | null;
  readonly metadata: JsonObject;
}

export interface TargetDictionaryQuery {
  readonly targetId: EntityId;
  readonly entityType: string;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface StartTargetTermCreationInput {
  readonly targetId: EntityId;
  readonly sourceId: EntityId;
  readonly observationId: EntityId;
  readonly entityType: string;
  readonly name: string;
  readonly slug?: string;
  readonly parentExternalId?: string;
  readonly actor: string;
}
