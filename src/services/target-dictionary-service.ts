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
  readonly slug?: string;
  readonly parentExternalId?: string;
  readonly reason?: string;
}

function providerCode(config: JsonObject, exporterCode: string): string {
  const configured = config.dictionaryProviderCode;
  return typeof configured === "string" && configured.trim() !== ""
    ? configured.trim()
    : exporterCode;
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "string" && entry.trim() !== "" ? [[key, entry.trim()]] : []),
  );
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

  async listTargets() {
    const targets = await this.repository.listTargets();
    return targets.map((target) => {
      const code = providerCode(target.config, target.exporterCode);
      const provider = this.providers.find(code);
      const entityOverrides = stringMap(target.config.dictionaryEntityMap);
      const scopeOverrides = stringMap(target.config.targetScopeMap);
      return {
        ...target,
        dictionary: {
          providerCode: code,
          configured: provider !== null,
          supportedEntityTypes: provider?.supportedEntityTypes ?? [],
          creatableEntityTypes: provider?.creatableEntityTypes ?? [],
          classificationCapabilities: (provider?.classificationCapabilities ?? []).map((capability) => ({
            ...capability,
            entityType: entityOverrides[capability.typeCode] ?? capability.entityType,
            targetScope: scopeOverrides[capability.targetScope] ?? capability.targetScope,
            creatable: provider?.creatableEntityTypes.includes(
              entityOverrides[capability.typeCode] ?? capability.entityType,
            ) ?? false,
          })),
        },
      };
    });
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

  async createTermAndDecide(command: CreateTargetTermCommand, actor = "admin-api") {
    const name = command.name.trim();
    if (name === "" || name.length > 200) {
      throw new IntegrationContractError("name must contain from 1 to 200 characters");
    }
    if (command.targetScope.trim() === "") {
      throw new IntegrationContractError("targetScope is required");
    }
    if (command.slug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(command.slug)) {
      throw new IntegrationContractError("slug must contain lowercase Latin letters, digits and hyphens");
    }
    if (command.parentExternalId !== undefined
      && (!/^\d+$/u.test(command.parentExternalId) || BigInt(command.parentExternalId) <= 0n)) {
      throw new IntegrationContractError("parentExternalId must be a positive integer");
    }
    if (command.parentExternalId !== undefined && command.entityType !== "product_categories") {
      throw new IntegrationContractError("parentExternalId is supported only for product_categories");
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

    const auditId = await this.repository.startTermCreation({
      targetId: command.targetId,
      sourceId: command.sourceId,
      observationId: decisionContext.observationId,
      entityType: command.entityType,
      name,
      ...(command.slug === undefined ? {} : { slug: command.slug }),
      ...(command.parentExternalId === undefined ? {} : { parentExternalId: command.parentExternalId }),
      actor,
    });
    let remoteExternalId: string | undefined;
    try {
      const remote = await provider.createTerm({
        entityType: command.entityType,
        name,
        sourceValue: decisionContext.sourceValue,
        sourceCode: decisionContext.sourceCode,
        requestReference: decisionContext.observationId,
        ...(command.slug === undefined ? {} : { slug: command.slug }),
        ...(command.parentExternalId === undefined ? {} : { parentExternalId: command.parentExternalId }),
      });
      remoteExternalId = remote.externalId;
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
      }, actor);
      await this.repository.completeTermCreation(auditId, dictionaryValue.externalId);
      return { dictionaryValue, decision };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown target term creation error";
      try {
        await this.repository.failTermCreation(auditId, message.slice(0, 2_000), remoteExternalId);
      } catch {
        // The target error is the primary failure and must remain visible to the operator.
      }
      throw error;
    }
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
