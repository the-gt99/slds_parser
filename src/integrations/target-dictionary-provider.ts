import type { JsonObject } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";

export interface TargetDictionaryRemoteValue {
  readonly externalId: string;
  readonly name: string;
  readonly slug?: string | null;
  readonly parentExternalId?: string | null;
  readonly taxonomy?: string | null;
  readonly attributeCode?: string | null;
  readonly remoteUpdatedAt?: string | null;
  readonly syncCursor?: string | null;
  readonly metadata: JsonObject;
}

export interface TargetDictionaryPage {
  readonly values: readonly TargetDictionaryRemoteValue[];
  readonly hasMore: boolean;
  readonly nextPage: number | null;
}

export interface CreateTargetTermInput {
  readonly entityType: string;
  readonly name: string;
  readonly sourceValue: string;
  readonly sourceCode: string;
  readonly requestReference: string;
  readonly slug?: string;
  readonly parentExternalId?: string;
  readonly relatedTerm?: {
    readonly relationCode: string;
    readonly entityType: string;
    readonly mode: "create" | "existing" | "none";
    readonly externalId?: string;
  };
}

export interface CreateTargetTermResult {
  readonly value: TargetDictionaryRemoteValue;
  readonly relatedValues: readonly {
    readonly entityType: string;
    readonly value: TargetDictionaryRemoteValue;
  }[];
}

export interface TargetTermRelationCapability {
  readonly relationCode: string;
  readonly sourceEntityType: string;
  readonly relatedEntityType: string;
  readonly targetScope: string;
  readonly label: string;
  readonly canCreateRelated: boolean;
  /** Path inside a synchronized dictionary value metadata object containing an existing related term external ID. */
  readonly relatedExternalIdPath?: readonly string[];
}

export interface TargetClassificationCapability {
  readonly typeCode: string;
  readonly entityType: string;
  readonly targetScope: string;
  readonly cardinality: "single" | "multiple";
}

export interface TargetDictionaryProvider {
  readonly code: string;
  readonly supportedEntityTypes: readonly string[];
  readonly creatableEntityTypes: readonly string[];
  readonly classificationCapabilities: readonly TargetClassificationCapability[];
  readonly termRelationCapabilities?: readonly TargetTermRelationCapability[];
  productEditUrl?(externalId: string): string;
  productPublicUrl?(externalId: string): string;
  fetchPage(entityType: string, page: number, perPage: number): Promise<TargetDictionaryPage>;
  createTerm(input: CreateTargetTermInput): Promise<CreateTargetTermResult>;
}

export class TargetDictionaryProviderRegistry {
  private readonly providers = new Map<string, TargetDictionaryProvider>();

  register(provider: TargetDictionaryProvider): void {
    if (this.providers.has(provider.code)) {
      throw new IntegrationContractError(`Target dictionary provider is already registered: ${provider.code}`);
    }
    this.providers.set(provider.code, provider);
  }

  get(code: string): TargetDictionaryProvider {
    const provider = this.providers.get(code);
    if (provider === undefined) throw new IntegrationContractError(`Target dictionary provider is not configured: ${code}`);
    return provider;
  }

  find(code: string): TargetDictionaryProvider | null {
    return this.providers.get(code) ?? null;
  }
}
