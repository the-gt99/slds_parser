import type { EntityId } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type {
  TargetClassificationImportRepository,
  TargetClassificationSuggestion,
  TargetClassificationSuggestionTarget,
  TargetClassificationSuggestionQuery,
  TargetClassificationSuggestionStatus,
} from "../repositories/index.js";
import type { ClassifierAdminService } from "./classifier-admin-service.js";

export class TargetClassificationImportService {
  constructor(
    private readonly repository: TargetClassificationImportRepository,
    private readonly classifier: ClassifierAdminService,
    private readonly targetBaseUrl?: string,
  ) {}

  start(targetId: EntityId, sourceId: EntityId, actor: string) {
    return this.repository.createRun(targetId, sourceId, actor);
  }

  list(query: TargetClassificationSuggestionQuery) {
    return this.repository.listSuggestions(query);
  }

  async examples(suggestionId: EntityId, perTargetLimit: number) {
    const result = await this.repository.listSuggestionExamples(suggestionId, perTargetLimit);
    if (result === null) throw new IntegrationContractError("Предложение WordPress не найдено");
    const baseUrl = this.targetBaseUrl?.replace(/\/+$/u, "");
    return {
      suggestion: result.suggestion,
      items: result.items.map((item) => ({
        ...item,
        targetUrl: baseUrl === undefined ? null : `${baseUrl}/?p=${encodeURIComponent(item.targetExternalId)}`,
        targetEditUrl: baseUrl === undefined
          ? null
          : `${baseUrl}/wp-admin/post.php?post=${encodeURIComponent(item.targetExternalId)}&action=edit`,
      })),
    };
  }

  async apply(input: {
    readonly runId: EntityId;
    readonly suggestionIds: readonly EntityId[];
  }, actor: string) {
    const ids = [...new Set(input.suggestionIds)];
    if (ids.length === 0 || ids.length > 50) {
      throw new IntegrationContractError("За один пакет можно применить от 1 до 50 предложений WordPress");
    }
    const run = await this.repository.getRun(input.runId);
    if (run === null || run.status !== "completed") {
      throw new IntegrationContractError("Завершённый импорт WordPress не найден");
    }
    if (run.targetEnabled) {
      throw new IntegrationContractError(`Target ${run.targetCode} должен быть выключен на время массовой классификации`);
    }
    const queuedCount = await this.repository.enqueueReadySuggestions({ runId: run.id, actor, suggestionIds: ids });
    if (queuedCount !== ids.length) {
      throw new IntegrationContractError("Часть выбранных предложений уже поставлена в очередь, применена или больше не готова; обновите список");
    }
    return { queuedCount };
  }

  async applyAll(input: {
    readonly runId: EntityId;
    readonly typeCode?: string;
    readonly search?: string;
  }, actor: string) {
    const run = await this.completedDisabledRun(input.runId);
    const queuedCount = await this.repository.enqueueReadySuggestions({
      runId: run.id,
      actor,
      ...(input.typeCode === undefined ? {} : { typeCode: input.typeCode }),
      ...(input.search === undefined ? {} : { search: input.search }),
    });
    return { queuedCount };
  }

  async applyQueued(input: { readonly runId: EntityId; readonly suggestionId: EntityId }, actor: string) {
    const run = await this.completedDisabledRun(input.runId);
    const suggestion = await this.repository.getSuggestion(run.id, input.suggestionId);
    if (suggestion === null || suggestion.status !== "queued") {
      return { status: "skipped" as const, affectedProductCount: 0 };
    }
    if (suggestion.dictionaryValueId === null) {
      throw new IntegrationContractError(`У предложения #${suggestion.id} отсутствует термин WordPress`);
    }
    const result = await this.applySuggestion(suggestion, {
      dictionaryValueId: suggestion.dictionaryValueId,
      externalValue: suggestion.externalValue ?? "",
      name: suggestion.targetName ?? suggestion.externalValue ?? "",
      productCount: suggestion.evidenceProductCount,
    }, run.id, actor);
    return { status: "completed" as const, affectedProductCount: result.affectedProductCount };
  }

  releaseQueued(suggestionId: EntityId, error: string): Promise<void> {
    return this.repository.releaseQueuedSuggestion(suggestionId, error);
  }

  async resolve(input: {
    readonly runId: EntityId;
    readonly suggestionId: EntityId;
    readonly dictionaryValueId: EntityId;
  }, actor: string) {
    const run = await this.repository.getRun(input.runId);
    if (run === null || run.status !== "completed") {
      throw new IntegrationContractError("Завершённый импорт WordPress не найден");
    }
    if (run.targetEnabled) {
      throw new IntegrationContractError(`Target ${run.targetCode} должен быть выключен на время классификации`);
    }
    const suggestion = await this.repository.getSuggestion(run.id, input.suggestionId);
    if (suggestion === null || suggestion.status !== "conflict") {
      throw new IntegrationContractError("Конфликт уже разрешён или не найден; обновите список");
    }
    const selected = suggestion.targets.find((target) => target.dictionaryValueId === input.dictionaryValueId);
    if (selected === undefined) {
      throw new IntegrationContractError("Выбранный термин не относится к этому конфликту");
    }
    const result = await this.applySuggestion(suggestion, selected, run.id, actor);
    return { appliedSuggestionId: suggestion.id, affectedProductCount: result.affectedProductCount };
  }

  private async applySuggestion(
    suggestion: TargetClassificationSuggestion,
    selected: TargetClassificationSuggestionTarget,
    runId: EntityId,
    actor: string,
  ): Promise<{ readonly affectedProductCount: number }> {
    if (selected.dictionaryValueId === null) {
      throw new IntegrationContractError("Выбранный термин отсутствует в локальном справочнике WordPress");
    }
    let resolutionKind: "mapping" | "rule";
    let resolutionId: EntityId;
    let affectedProductCount: number;
    if (suggestion.suggestionKind === "mapping") {
        const result = await this.classifier.saveDecision({
          sourceId: suggestion.sourceId,
          typeCode: suggestion.typeCode,
          scope: suggestion.scope,
          normalizedSourceValue: suggestion.normalizedSourceValue,
          contextKey: suggestion.contextKey,
          action: "confirm",
          targetLink: {
            targetId: suggestion.targetId,
            targetScope: suggestion.targetScope,
            dictionaryValueId: selected.dictionaryValueId,
          },
          reason: `Подтверждено назначениями существующих товаров WordPress, импорт #${runId}`,
        }, actor);
        affectedProductCount = result.affectedProductCount;
        resolutionKind = "mapping";
        resolutionId = result.mappingId;
      } else {
        const brand = typeof suggestion.context.brand === "string" ? suggestion.context.brand.trim() : "";
        const family = typeof suggestion.context.family === "string" ? suggestion.context.family.trim() : "";
        if (brand === "" || family === "") {
          throw new IntegrationContractError(`У предложения модели #${suggestion.id} отсутствуют brand/family`);
        }
        const draft = {
          sourceId: suggestion.sourceId,
          typeCode: suggestion.typeCode,
          name: `WordPress: ${brand} / ${family}`,
          priority: 100,
          conditions: [
            { field: "context.brand", operator: "equals" as const, value: brand },
            { field: "context.family", operator: "equals" as const, value: family },
          ],
          targetLink: {
            targetId: suggestion.targetId,
            targetScope: suggestion.targetScope,
            dictionaryValueId: selected.dictionaryValueId,
          },
          reason: `Подтверждено назначениями существующих товаров WordPress, импорт #${runId}`,
        };
        const result = await this.classifier.createRule(draft, actor, { rejectAmbiguous: true });
        affectedProductCount = result.preview.affectedProducts;
        resolutionKind = "rule";
        resolutionId = result.ruleId;
      }
    await this.repository.markApplied({
      suggestionId: suggestion.id,
      dictionaryValueId: selected.dictionaryValueId,
      externalValue: selected.externalValue,
      targetName: selected.name,
      resolutionKind,
      resolutionId,
      actor,
    });
    return { affectedProductCount };
  }

  private async completedDisabledRun(runId: EntityId) {
    const run = await this.repository.getRun(runId);
    if (run === null || run.status !== "completed") {
      throw new IntegrationContractError("Завершённый импорт WordPress не найден");
    }
    if (run.targetEnabled) {
      throw new IntegrationContractError(`Target ${run.targetCode} должен быть выключен на время массовой классификации`);
    }
    return run;
  }
}

export function targetClassificationSuggestionStatus(value: string | undefined): TargetClassificationSuggestionStatus | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "ready" && value !== "queued" && value !== "conflict" && value !== "applied") {
    throw new IntegrationContractError("status must be ready, queued, conflict or applied");
  }
  return value;
}
