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
  readonly sourceId: EntityId | null;
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
}

export interface SaveProductClassificationInput {
  readonly sourceId: EntityId;
  readonly sourceProductId: EntityId;
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
  readonly metadata: JsonObject;
  readonly revision: string;
}

export interface SaveTargetClassificationProjectionInput {
  readonly targetId: EntityId;
  readonly resolutionKind: ReferenceResolutionKind;
  readonly resolutionId: EntityId;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly actor: string;
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
  readonly context: JsonObject;
  readonly evidence: JsonObject;
  readonly status: "resolved" | "ignored" | "unresolved" | "ambiguous";
  readonly issueReason: ClassificationIssueReason | null;
  readonly resolvedReferenceValueId: EntityId | null;
  readonly resolvedReferenceName: string | null;
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

export type ClassificationReviewStatus = "unresolved" | "ambiguous";

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

export interface ClassificationReviewItem extends ClassificationDecisionKey {
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
  readonly limit: number;
  readonly offset: number;
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
  readonly candidate: ReferenceCandidateDTO;
}

export interface CreateClassificationRuleInput {
  readonly sourceId: EntityId;
  readonly typeCode: string;
  readonly name: string;
  readonly priority: number;
  readonly conditions: readonly ClassificationRuleConditionRecord[];
  readonly referenceValueId: EntityId;
  readonly actor: string;
  readonly reason?: string;
  readonly affectedSourceProductIds: readonly EntityId[];
}

export interface CreateClassificationRuleResult {
  readonly ruleId: EntityId;
  readonly revision: string;
  readonly affectedProductCount: number;
}

export interface ClassificationDecisionContext extends ClassificationDecisionKey {
  readonly observationId: EntityId;
  readonly sourceCode: string;
  readonly sourceValue: string;
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
