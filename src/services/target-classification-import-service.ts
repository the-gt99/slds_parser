import type { EntityId } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type {
  TargetClassificationImportRepository,
  TargetClassificationSuggestionQuery,
  TargetClassificationSuggestionStatus,
} from "../repositories/index.js";
import type { ClassifierAdminService } from "./classifier-admin-service.js";

export class TargetClassificationImportService {
  constructor(
    private readonly repository: TargetClassificationImportRepository,
    private readonly classifier: ClassifierAdminService,
  ) {}

  start(targetId: EntityId, sourceId: EntityId, actor: string) {
    return this.repository.createRun(targetId, sourceId, actor);
  }

  list(query: TargetClassificationSuggestionQuery) {
    return this.repository.listSuggestions(query);
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
    const suggestions = await this.repository.getReadySuggestions(run.id, ids);
    if (suggestions.length !== ids.length) {
      throw new IntegrationContractError("Часть выбранных предложений уже применена или больше не готова; обновите список");
    }

    let affectedProductCount = 0;
    const appliedSuggestionIds: EntityId[] = [];
    for (const suggestion of suggestions) {
      if (suggestion.dictionaryValueId === null) {
        throw new IntegrationContractError(`У предложения #${suggestion.id} отсутствует термин WordPress`);
      }
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
            dictionaryValueId: suggestion.dictionaryValueId,
          },
          reason: `Подтверждено назначениями существующих товаров WordPress, импорт #${run.id}`,
        }, actor);
        affectedProductCount += result.affectedProductCount;
        await this.repository.markApplied(suggestion.id, "mapping", result.mappingId, actor);
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
            dictionaryValueId: suggestion.dictionaryValueId,
          },
          reason: `Подтверждено назначениями существующих товаров WordPress, импорт #${run.id}`,
        };
        const preview = await this.classifier.previewRule(draft);
        if (preview.ambiguousObservations > 0) {
          throw new IntegrationContractError(`Предложение #${suggestion.id} конфликтует с существующими правилами`);
        }
        const result = await this.classifier.createRule(draft, actor);
        affectedProductCount += result.preview.affectedProducts;
        await this.repository.markApplied(suggestion.id, "rule", result.ruleId, actor);
      }
      appliedSuggestionIds.push(suggestion.id);
    }
    return { appliedCount: appliedSuggestionIds.length, affectedProductCount, appliedSuggestionIds };
  }
}

export function targetClassificationSuggestionStatus(value: string | undefined): TargetClassificationSuggestionStatus | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "ready" && value !== "conflict" && value !== "applied") {
    throw new IntegrationContractError("status must be ready, conflict or applied");
  }
  return value;
}
