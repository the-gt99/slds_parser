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
