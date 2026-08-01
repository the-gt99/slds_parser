export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface SourceProductReference {
  readonly sourceKey: string;
  readonly externalId: string;
  readonly locator: string;
}

export interface DiscoveryResult {
  readonly items: readonly SourceProductReference[];
  readonly discoveredAt: string;
}

export interface SourceProductPartDTO {
  readonly partKey: string;
  readonly data: JsonValue;
}

export interface CollectedSourceProduct {
  readonly sourceKey: string;
  readonly externalId: string;
  readonly collectedAt: string;
  readonly parts: readonly SourceProductPartDTO[];
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

export interface UniversalProductDTO {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly price?: MoneyDTO;
  readonly inventory: InventoryDTO;
  readonly attributes: Readonly<Record<string, JsonValue>>;
}

export interface ExportResult {
  readonly status: "created" | "updated" | "unchanged";
  readonly externalId: string;
  readonly exportedAt: string;
}
