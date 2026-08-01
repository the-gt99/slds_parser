import type { EntityId, JsonObject } from "../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type {
  TargetDictionaryProvider,
  TargetDictionaryProviderRegistry,
  TargetDictionaryRemoteValue,
} from "../integrations/index.js";
import type {
  ClassificationDecisionKey,
  TargetDictionaryQuery,
  TargetDictionaryRepository,
  TargetDictionaryValueInput,
} from "../repositories/index.js";
import type { ClassifierAdminService } from "./classifier-admin-service.js";

export interface CreateTargetTermCommand extends ClassificationDecisionKey {
  readonly targetId: EntityId;
  readonly targetScope: string;
  readonly entityType: string;
  readonly name: string;
  readonly reason?: string;
}

function providerCode(config: JsonObject, exporterCode: string): string {
  const configured = config.dictionaryProviderCode;
  return typeof configured === "string" && configured.trim() !== ""
    ? configured.trim()
    : exporterCode;
}

function dictionaryInput(value: TargetDictionaryRemoteValue): TargetDictionaryValueInput {
  return {
    externalId: value.externalId,
    name: value.name,
    slug: value.slug ?? null,
    parentExternalId: value.parentExternalId ?? null,
    taxonomy: value.taxonomy ?? null,
    attributeCode: value.attributeCode ?? null,
    remoteUpdatedAt: value.remoteUpdatedAt ?? null,
    syncCursor: value.syncCursor ?? null,
    metadata: value.metadata,
  };
}

export class TargetDictionaryService {
  constructor(
    private readonly repository: TargetDictionaryRepository,
    private readonly providers: TargetDictionaryProviderRegistry,
    private readonly classifier: ClassifierAdminService,
  ) {}

  listTargets() {
    return this.repository.listTargets();
  }

  listValues(query: TargetDictionaryQuery) {
    return this.repository.listValues(query);
  }

  async sync(targetId: EntityId, requestedEntityTypes?: readonly string[]) {
    const { provider } = await this.resolveTarget(targetId);
    const entityTypes = requestedEntityTypes === undefined
      ? provider.supportedEntityTypes
      : requestedEntityTypes;
    if (entityTypes.length === 0) {
      throw new IntegrationContractError("At least one dictionary entity type is required");
    }
    const unknown = entityTypes.filter((entityType) => !provider.supportedEntityTypes.includes(entityType));
    if (unknown.length > 0) {
      throw new IntegrationContractError(`Unsupported dictionary entity types: ${unknown.join(", ")}`);
    }

    const counts: Record<string, number> = {};
    for (const entityType of [...new Set(entityTypes)]) {
      const values = await this.fetchAll(provider, entityType);
      counts[entityType] = await this.repository.replaceEntityValues(
        targetId,
        entityType,
        values.map(dictionaryInput),
      );
    }
    return { targetId, counts };
  }

  async createTermAndDecide(command: CreateTargetTermCommand) {
    const name = command.name.trim();
    if (name === "" || name.length > 200) {
      throw new IntegrationContractError("name must contain from 1 to 200 characters");
    }
    if (command.targetScope.trim() === "") {
      throw new IntegrationContractError("targetScope is required");
    }
    const [{ provider }, decisionContext] = await Promise.all([
      this.resolveTarget(command.targetId),
      this.classifier.getDecisionContext(command),
    ]);
    if (decisionContext === null) {
      throw new EntityNotFoundError("Classification observation", `${command.sourceId}/${command.typeCode}/${command.normalizedSourceValue}`);
    }
    if (!provider.creatableEntityTypes.includes(command.entityType)) {
      throw new IntegrationContractError(`Creating ${command.entityType} terms is not supported by this target`);
    }

    const remote = await provider.createTerm({
      entityType: command.entityType,
      name,
      sourceValue: decisionContext.sourceValue,
      sourceCode: decisionContext.sourceCode,
      requestReference: decisionContext.observationId,
    });
    const dictionaryValue = await this.repository.upsertValue(
      command.targetId,
      command.entityType,
      dictionaryInput(remote),
    );
    const decision = await this.classifier.saveDecision({
      sourceId: command.sourceId,
      typeCode: command.typeCode,
      scope: command.scope,
      normalizedSourceValue: command.normalizedSourceValue,
      contextKey: command.contextKey,
      action: "confirm",
      targetLink: {
        targetId: command.targetId,
        targetScope: command.targetScope,
        dictionaryValueId: dictionaryValue.id,
      },
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    });
    return { dictionaryValue, decision };
  }

  private async resolveTarget(targetId: EntityId): Promise<{ readonly provider: TargetDictionaryProvider }> {
    const target = (await this.repository.listTargets()).find((item) => item.id === targetId);
    if (target === undefined) throw new EntityNotFoundError("Target", targetId);
    return { provider: this.providers.get(providerCode(target.config, target.exporterCode)) };
  }

  private async fetchAll(provider: TargetDictionaryProvider, entityType: string) {
    const values: TargetDictionaryRemoteValue[] = [];
    const seenIds = new Set<string>();
    let page = 1;
    for (let requestCount = 0; requestCount < 1_000; requestCount += 1) {
      const response = await provider.fetchPage(entityType, page, 200);
      for (const value of response.values) {
        if (seenIds.has(value.externalId)) {
          throw new IntegrationContractError(`Duplicate target dictionary ID ${entityType}/${value.externalId}`);
        }
        seenIds.add(value.externalId);
        values.push(value);
      }
      if (!response.hasMore) return values;
      const nextPage = response.nextPage ?? page + 1;
      if (!Number.isInteger(nextPage) || nextPage <= page) {
        throw new IntegrationContractError(`Invalid next page for target dictionary ${entityType}`);
      }
      page = nextPage;
    }
    throw new IntegrationContractError(`Target dictionary ${entityType} exceeded 1000 pages`);
  }
}
