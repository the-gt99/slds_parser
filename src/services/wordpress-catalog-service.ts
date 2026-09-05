import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type {
  SourceRepository,
  TargetRepository,
  WordPressCatalogAuditFilter,
  WordPressCatalogMatchStatus,
  WordPressCatalogOperationFilter,
  WordPressCatalogRepository,
  WordPressCatalogRiskFilter,
  WordPressCatalogVariationFilter,
} from "../repositories/index.js";

export class WordPressCatalogService {
  private static readonly variationSubmitBatchSize = 100;

  constructor(
    private readonly repository: WordPressCatalogRepository,
    private readonly sources: SourceRepository,
    private readonly targets: TargetRepository,
  ) {}

  async createRun(input: {
    readonly targetId: string;
    readonly sourceCode: string;
    readonly auditRequested: boolean;
    readonly variationSyncRequested: boolean;
    readonly actor: string;
    readonly reason?: string;
  }) {
    const activeSync = await this.repository.getActiveVariationSync();
    if (activeSync !== null) {
      throw new IntegrationContractError(`Сначала отключите постоянное обновление каталога #${activeSync.runId}`);
    }
    if (input.variationSyncRequested) {
      throw new IntegrationContractError("Параллельную запись нельзя включить до успешного canary; сначала создайте снимок, затем запускайте ограниченные пакеты");
    }
    const target = await this.targets.getById(input.targetId);
    if (target === null) throw new EntityNotFoundError("target", input.targetId);
    const sourceCode = input.sourceCode.trim().toLocaleLowerCase("en-US");
    const source = (await this.sources.listEnabled()).find((item) => item.code.toLocaleLowerCase("en-US") === sourceCode);
    if (source === undefined) throw new IntegrationContractError(`Enabled source not found: ${sourceCode}`);
    return this.repository.createRun({ ...input, sourceCode });
  }

  async listRuns(targetId: string, limit = 20) {
    return this.repository.listRuns(targetId, Math.max(1, Math.min(100, limit)));
  }

  async getRun(runId: string) {
    const run = await this.repository.getRun(runId);
    if (run === null) throw new EntityNotFoundError("wordpress catalog run", runId);
    return run;
  }

  async listItems(input: {
    readonly runId: string;
    readonly search?: string;
    readonly matchStatus?: WordPressCatalogMatchStatus;
    readonly auditStatus?: WordPressCatalogAuditFilter;
    readonly risk?: WordPressCatalogRiskFilter;
    readonly operation?: WordPressCatalogOperationFilter;
    readonly changeFlag?: string;
    readonly variationFilter?: WordPressCatalogVariationFilter;
    readonly limit: number;
    readonly offset: number;
  }) {
    await this.getRun(input.runId);
    return this.repository.listItems({
      ...input,
      ...(input.search?.trim() ? { search: input.search.trim().slice(0, 200) } : {}),
      limit: Math.max(1, Math.min(200, input.limit)),
      offset: Math.max(0, input.offset),
    });
  }

  async getItem(runId: string, itemId: string) {
    await this.getRun(runId);
    const item = await this.repository.getItem(runId, itemId);
    if (item === null) throw new EntityNotFoundError("wordpress catalog item", itemId);
    return item;
  }

  async retryBlockedAudits(runId: string) {
    const run = await this.getRun(runId);
    if (!run.catalogComplete || !run.auditRequested) {
      throw new IntegrationContractError("Повторный аудит доступен только для завершённого снимка с включённым аудитом");
    }
    return this.repository.retryBlockedAudits(runId);
  }

  async rebuildAudits(runId: string, changeFlag?: string) {
    const run = await this.getRun(runId);
    if (!run.catalogComplete || !run.auditRequested) {
      throw new IntegrationContractError("Пересчёт аудита доступен только для завершённого снимка с включённым аудитом");
    }
    const normalizedFlag = changeFlag?.trim();
    return this.repository.rebuildAudits(runId, normalizedFlag === "" ? undefined : normalizedFlag);
  }

  async enqueueVariationCanary(runId: string, itemId: string) {
    await this.getRun(runId);
    const queuedCount = await this.repository.enqueueVariationItems(runId, [itemId]);
    if (queuedCount !== 1) throw new IntegrationContractError("Товар нельзя поставить в canary: он не сопоставлен, уже выполняется или уже завершён");
    return { queuedCount };
  }

  async startVariationAutoSync(runId: string, window = 1_000, intervalMinutes = 360) {
    const run = await this.getRun(runId);
    if (!run.catalogComplete) throw new IntegrationContractError("Постоянное обновление нельзя включить до полного сохранения каталога WordPress");
    if (run.variationAutoStatus === "running" || run.variationAutoStatus === "paused") {
      throw new IntegrationContractError("Постоянное обновление уже настроено; сначала отключите его");
    }
    if (run.variationCompletedCount < 1 || run.variationFailedCount > 0) {
      throw new IntegrationContractError("Полный поток нельзя включить до успешного canary без ошибок");
    }
    if (!Number.isInteger(window) || window < 1 || window > 5_000) {
      throw new IntegrationContractError("Окно обновления должно быть от 1 до 5000 товаров");
    }
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 10_080) {
      throw new IntegrationContractError("Интервал обновления должен быть от 5 минут до 7 дней");
    }
    const active = await this.repository.getActiveVariationSync();
    if (active !== null && active.runId !== runId) {
      throw new IntegrationContractError(`Уже выполняется постоянное обновление каталога #${active.runId}`);
    }
    await this.repository.startVariationAutoSync(runId, window, intervalMinutes);
    await this.tickVariationAutoSync();
    return this.getRun(runId);
  }

  async pauseVariationAutoSync(runId: string) {
    const run = await this.getRun(runId);
    if (run.variationAutoStatus !== "running") {
      throw new IntegrationContractError("Постоянное обновление сейчас не выполняется");
    }
    await this.repository.setVariationAutoSyncStatus({ runId, status: "paused" });
    return this.getRun(runId);
  }

  async resumeVariationAutoSync(runId: string) {
    const run = await this.getRun(runId);
    if (run.variationAutoStatus !== "paused") {
      throw new IntegrationContractError("Возобновить можно только остановленный автопрогон");
    }
    await this.repository.setVariationAutoSyncStatus({
      runId,
      status: "running",
      acknowledgeFailures: run.variationFailedCount,
    });
    await this.tickVariationAutoSync();
    return this.getRun(runId);
  }

  async stopVariationAutoSync(runId: string) {
    const run = await this.getRun(runId);
    if (run.variationAutoStatus !== "running" && run.variationAutoStatus !== "paused") {
      throw new IntegrationContractError("Постоянное обновление сейчас не запущено");
    }
    await this.repository.setVariationAutoSyncStatus({ runId, status: "inactive" });
    return this.getRun(runId);
  }

  async tickVariationAutoSync(): Promise<boolean> {
    const active = await this.repository.getActiveVariationSync();
    if (active !== null && await this.repository.enqueueReadyVariationBatches(active.runId, WordPressCatalogService.variationSubmitBatchSize) > 0) return true;
    const outcome = await this.repository.replenishVariationAutoSync();
    return outcome !== "idle" && outcome !== "waiting";
  }

}
