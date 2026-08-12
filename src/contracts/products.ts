export type EntityId = string;

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface SourceDTO {
  /** String representation of a PostgreSQL BIGINT identifier. */
  readonly id: EntityId;
  readonly code: string;
  readonly config: JsonObject;
}

export interface TargetDTO {
  /** String representation of a PostgreSQL BIGINT identifier. */
  readonly id: EntityId;
  readonly code: string;
  readonly config: JsonObject;
}

export interface TargetContentTemplateDTO {
  readonly id: EntityId;
  readonly field: "description" | "short_description";
  readonly revision: number;
  readonly templateSource: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly managementMode: "manage" | "preserve";
  readonly categoryTermIds: readonly number[];
  readonly requiredContextPaths: readonly string[];
}

export interface DiscoveredSourceProduct {
  readonly sourceKey: string;
  readonly externalId?: string;
  readonly slug?: string;
  readonly url?: string;
  readonly sourceUpdatedAt?: string;
  readonly metadata: JsonObject;
}

export interface DiscoveryInput {
  readonly source: SourceDTO;
  readonly runType: string;
  readonly checkpoint: JsonValue;
}

export type DiscoveryCompleteness = "complete" | "partial" | "unknown";

export interface DiscoveryStats {
  readonly processed: number;
  readonly discovered: number;
}

export interface DiscoveryResult {
  readonly items: readonly DiscoveredSourceProduct[];
  readonly checkpoint: JsonValue;
  readonly hasMore: boolean;
  readonly completeness: DiscoveryCompleteness;
  readonly stats: DiscoveryStats;
}

export interface CollectProductInput {
  readonly source: SourceDTO;
  readonly product: DiscoveredSourceProduct;
  readonly requestedPartKeys?: readonly string[];
}

export interface SourceProductPartDTO {
  readonly partKey: string;
  readonly rawPayload: JsonValue;
  readonly parsedPayload: JsonValue;
  readonly sourceUpdatedAt?: string;
  readonly adapterVersion: string;
}

export interface CollectedSourceProduct {
  readonly sourceKey: string;
  readonly externalId?: string;
  readonly slug?: string;
  readonly url?: string;
  /**
   * Every requested part must be returned, even when its payload is empty.
   * A failure to retrieve a part must not overwrite its previously stored value.
   */
  readonly parts: readonly SourceProductPartDTO[];
}

export interface SourceProductDTO {
  /** String representation of a PostgreSQL BIGINT identifier. */
  readonly id: EntityId;
  readonly sourceId: EntityId;
  readonly sourceKey: string;
  readonly externalId?: string;
  readonly slug?: string;
  readonly url?: string;
  readonly metadata: JsonObject;
}

export interface ProcessingContext {
  readonly source: SourceDTO;
  readonly sourceProduct: SourceProductDTO;
  readonly parts: readonly SourceProductPartDTO[];
}

export interface ProductOperationContext {
  readonly source: SourceDTO;
  readonly sourceProduct: SourceProductDTO;
  readonly previousProduct?: UniversalProductDTO;
}

export interface MoneyDTO {
  /** Decimal value, for example "1499.90". */
  readonly amount: string;
  /** ISO 4217 currency code. */
  readonly currency: string;
}

export type Availability =
  | "available"
  | "unavailable"
  | "preorder"
  | "unknown";

export interface InventoryDTO {
  readonly availability: Availability;
  readonly quantity?: number;
}

export interface ProductImageDTO {
  /** Original source URL. Set by normalization before local media processing. */
  readonly sourceUrl?: string;
  readonly url: string;
  readonly position: number;
  readonly alt: string;
  readonly localPath?: string;
  readonly webpLocalPath?: string;
  readonly mimeType?: string;
  readonly storedFormat?: string;
  readonly width?: number;
  readonly height?: number;
  /** SHA-256 of the bytes received from the source before conversion. */
  readonly sourceContentHash?: string;
  /** SHA-256 of the final published image bytes. */
  readonly contentHash?: string;
  /** 64-bit perceptual dHash of the rendered image. */
  readonly perceptualHash?: string;
  readonly attributes: JsonObject;
}

export interface ProductTranslatedContentDTO {
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly description: string;
  readonly story: string;
  readonly color: string;
  readonly details: string;
  readonly upperMaterial: string;
}

export type ReferenceSubjectKind = "product" | "variant";

/**
 * A source-neutral value that may be linked to an internal reference value.
 * Source processors and enrichment operations produce candidates; the
 * classifier resolves them without knowing the source payload shape.
 */
export interface ReferenceCandidateDTO {
  /** Stable and unique inside one product, for example `product:brand`. */
  readonly key: string;
  readonly typeCode: string;
  /** Distinguishes semantic uses of the same reference type. */
  readonly scope: string;
  readonly subjectKind: ReferenceSubjectKind;
  /** Required when subjectKind is `variant`. */
  readonly subjectKey?: string;
  readonly sourceValue: string;
  /** Values that make exact source mappings context-sensitive. */
  readonly context: JsonObject;
  /** Additional source-neutral facts available to classification rules. */
  readonly evidence: JsonObject;
}

export type ReferenceResolutionKind = "mapping" | "rule";

export interface ClassifiedReferenceDTO {
  readonly candidateKey: string;
  readonly typeCode: string;
  readonly scope: string;
  readonly subjectKind: ReferenceSubjectKind;
  readonly subjectKey?: string;
  readonly referenceValueId: EntityId;
  readonly resolutionKind: ReferenceResolutionKind;
  readonly resolutionId: EntityId;
  readonly resolutionRevision: string;
}

export type ClassificationIssueReason = "mapping_missing" | "rule_ambiguous";

export interface UnresolvedReferenceDTO {
  readonly candidateKey: string;
  readonly typeCode: string;
  readonly scope: string;
  readonly subjectKind: ReferenceSubjectKind;
  readonly subjectKey?: string;
  readonly sourceValue: string;
  readonly reason: ClassificationIssueReason;
}

export interface IgnoredReferenceDTO {
  readonly candidateKey: string;
  readonly typeCode: string;
  readonly scope: string;
  readonly subjectKind: ReferenceSubjectKind;
  readonly subjectKey?: string;
  readonly sourceValue: string;
  readonly mappingId: EntityId;
  readonly mappingRevision: string;
}

export interface ProductClassificationDTO {
  readonly status: "complete" | "partial";
  readonly classifierVersion: string;
  readonly fingerprint: string;
  readonly resolved: readonly ClassifiedReferenceDTO[];
  readonly ignored: readonly IgnoredReferenceDTO[];
  readonly unresolved: readonly UnresolvedReferenceDTO[];
}

export interface ProductSizeDTO {
  readonly sourceValue: string;
  readonly displayValue: string;
  /** Source-neutral size system key, for example `us-numeric` or `standard-clothing`. */
  readonly system?: string;
  /** Source-neutral audience key used when a target has separate size terms. */
  readonly audience?: "men" | "women" | "youth" | "infant" | "unisex";
}

export interface ProductVariantDTO {
  readonly sourceVariantKey: string;
  readonly sku: string;
  readonly size: ProductSizeDTO;
  readonly price: MoneyDTO | null;
  readonly inventory: InventoryDTO;
  readonly attributes: JsonObject;
}

export interface UniversalProductDTO {
  readonly sourceProductId: EntityId;
  readonly title: string;
  readonly description: string;
  readonly sku: string;
  readonly images: readonly ProductImageDTO[];
  readonly variants: readonly ProductVariantDTO[];
  readonly referenceCandidates: readonly ReferenceCandidateDTO[];
  readonly classification?: ProductClassificationDTO;
  readonly translatedContent?: ProductTranslatedContentDTO;
  readonly attributes: JsonObject;
  readonly metadata: JsonObject;
}

export interface TargetReferenceResolutionInput {
  readonly referenceId: EntityId;
  readonly referenceType: string;
  readonly targetScope: string;
}

export interface TargetProjectionResolutionInput {
  readonly resolutionKind: ReferenceResolutionKind;
  readonly resolutionId: EntityId;
  readonly referenceId: EntityId;
}

export interface ExportRefreshDTO {
  readonly variants: readonly ProductVariantDTO[];
}

export interface TargetReferenceProjectionDTO {
  readonly resolutionKind: ReferenceResolutionKind | "reference";
  readonly resolutionId: EntityId;
  readonly targetScope: string;
  readonly externalValue: string;
  readonly externalLabel: string;
  readonly externalSlug: string | null;
  readonly provenance?: {
    readonly kind: "related_target_term";
    readonly relationCode: string;
    readonly sourceTypeCode: string;
    readonly sourceLabel: string;
  };
}

export interface TargetAssignmentDTO {
  readonly ruleId: EntityId;
  readonly groupCode: string;
  readonly targetScope: string;
  readonly externalValue: string;
  readonly mode: "add" | "replace";
}

export interface TargetReferenceResolver {
  resolveReference(
    input: TargetReferenceResolutionInput,
  ): Promise<string>;
  resolveProjections(
    inputs: readonly TargetProjectionResolutionInput[],
  ): Promise<readonly TargetReferenceProjectionDTO[]>;
  resolveAssignments(product: UniversalProductDTO): Promise<readonly TargetAssignmentDTO[]>;
}

export interface ExportContext {
  readonly source: SourceDTO;
  readonly sourceProduct: SourceProductDTO;
  readonly target: TargetDTO;
  readonly product: UniversalProductDTO;
  /** Commerce data fetched immediately before the target write. */
  readonly liveVariants?: readonly ProductVariantDTO[];
  readonly references: TargetReferenceResolver;
  readonly contentTemplates?: readonly TargetContentTemplateDTO[];
  readonly existingExternalId?: string;
  readonly approval?: {
    readonly payloadHash: string;
    readonly willCreate: boolean;
    readonly externalId: string | null;
    readonly matchedBy: string | null;
  };
}

export type ExportOperation = "created" | "updated" | "skipped";

export interface ExportResult {
  readonly externalId: string;
  readonly operation: ExportOperation;
  readonly metadata: JsonObject;
}
