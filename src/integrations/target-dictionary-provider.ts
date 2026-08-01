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
}

export interface TargetDictionaryProvider {
  readonly code: string;
  readonly supportedEntityTypes: readonly string[];
  readonly creatableEntityTypes: readonly string[];
  fetchPage(entityType: string, page: number, perPage: number): Promise<TargetDictionaryPage>;
  createTerm(input: CreateTargetTermInput): Promise<TargetDictionaryRemoteValue>;
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
}
