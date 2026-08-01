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

export interface SourceReferenceResolutionInput {
  readonly referenceType: string;
  readonly sourceValue: string;
}

export interface SourceReferenceResolver {
  resolveReference(
    input: SourceReferenceResolutionInput,
  ): Promise<EntityId | undefined>;
}

export interface ProcessingContext {
  readonly source: SourceDTO;
  readonly sourceProduct: SourceProductDTO;
  readonly parts: readonly SourceProductPartDTO[];
  readonly references: SourceReferenceResolver;
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
  readonly url: string;
  readonly position: number;
  readonly alt: string;
  readonly attributes: JsonObject;
}

export interface ProductSizeDTO {
  readonly sourceValue: string;
  readonly displayValue: string;
  readonly sizeSystemReferenceId?: EntityId;
}

export interface ProductVariantDTO {
  readonly sourceVariantKey: string;
  readonly sku: string;
  readonly size: ProductSizeDTO;
  readonly price: MoneyDTO;
  readonly inventory: InventoryDTO;
  readonly conditionReferenceId: EntityId | null;
  readonly attributes: JsonObject;
}

export interface UniversalProductDTO {
  readonly sourceProductId: EntityId;
  readonly title: string;
  readonly description: string;
  readonly sku: string;
  readonly brandReferenceId: EntityId | null;
  readonly categoryReferenceIds: readonly EntityId[];
  readonly genderReferenceId: EntityId | null;
  readonly images: readonly ProductImageDTO[];
  readonly variants: readonly ProductVariantDTO[];
  readonly attributes: JsonObject;
  readonly metadata: JsonObject;
}

export interface TargetReferenceResolutionInput {
  readonly referenceId: EntityId;
  readonly referenceType: string;
}

export interface TargetReferenceResolver {
  resolveReference(
    input: TargetReferenceResolutionInput,
  ): Promise<string | undefined>;
}

export interface ExportContext {
  readonly target: TargetDTO;
  readonly product: UniversalProductDTO;
  readonly references: TargetReferenceResolver;
  readonly existingExternalId?: string;
}

export type ExportOperation = "created" | "updated" | "skipped";

export interface ExportResult {
  readonly externalId: string;
  readonly operation: ExportOperation;
  readonly metadata: JsonObject;
}
