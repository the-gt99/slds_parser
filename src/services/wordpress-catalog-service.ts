import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type {
  SourceRepository,
  TargetRepository,
  WordPressCatalogMatchStatus,
  WordPressCatalogRepository,
  WordPressCatalogVariationFilter,
} from "../repositories/index.js";

export class WordPressCatalogService {
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
    readonly matchStatus?: WordPressCatalogMatchStatus;
    readonly variationFilter?: WordPressCatalogVariationFilter;
    readonly limit: number;
    readonly offset: number;
  }) {
    await this.getRun(input.runId);
    return this.repository.listItems({
      ...input,
      limit: Math.max(1, Math.min(200, input.limit)),
      offset: Math.max(0, input.offset),
    });
  }

  async enqueueVariationCanary(runId: string, itemId: string) {
    await this.getRun(runId);
    const queuedCount = await this.repository.enqueueVariationItems(runId, [itemId]);
    if (queuedCount !== 1) throw new IntegrationContractError("Товар нельзя поставить в canary: он не сопоставлен, уже выполняется или уже завершён");
    return { queuedCount };
  }

  async startVariationAutoSync(runId: string, window = 5_000) {
    const run = await this.getRun(runId);
    if (!run.catalogComplete) throw new IntegrationContractError("Автопрогон нельзя запустить до полного сохранения каталога WordPress");
    if (run.variationCompletedCount < 1 || run.variationFailedCount > 0) {
      throw new IntegrationContractError("Полный поток нельзя включить до успешного canary без ошибок");
    }
    if (!Number.isInteger(window) || window < 1 || window > 5_000) {
      throw new IntegrationContractError("Окно автопрогона должно быть от 1 до 5000 товаров");
    }
    const active = await this.repository.getRunningVariationAutoSync();
    if (active !== null && active.runId !== runId) {
      throw new IntegrationContractError(`Уже выполняется автопрогон каталога #${active.runId}`);
    }
    await this.repository.startVariationAutoSync(runId, window);
    await this.tickVariationAutoSync();
    return this.getRun(runId);
  }

  async pauseVariationAutoSync(runId: string) {
    const run = await this.getRun(runId);
    if (run.variationAutoStatus !== "running") {
      throw new IntegrationContractError("Автопрогон сейчас не выполняется");
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

  async tickVariationAutoSync(): Promise<boolean> {
    const run = await this.repository.getRunningVariationAutoSync();
    if (run === null) return false;
    if (run.failedCount > run.acknowledgedFailedCount) {
      await this.repository.setVariationAutoSyncStatus({
        runId: run.runId,
        status: "paused",
        error: "Автопрогон остановлен после ошибки товара. Проверьте журнал и возобновите вручную.",
      });
      return true;
    }
    const available = Math.max(0, run.window - run.activeCount);
    if (available === 0) return false;
    const queued = await this.repository.enqueueVariationBatch(run.runId, available);
    if (queued > 0) return true;
    if (run.activeCount > 0) return false;
    await this.repository.setVariationAutoSyncStatus({ runId: run.runId, status: "completed" });
    return true;
  }

  async enqueueVariationBatch(runId: string, limit: number) {
    const run = await this.getRun(runId);
    if (run.variationAutoStatus === "running" || run.variationAutoStatus === "paused") {
      throw new IntegrationContractError("Ручной пакет недоступен, пока автопрогон выполняется или остановлен для проверки");
    }
    if (run.variationCompletedCount < 1 || run.variationFailedCount > 0) {
      throw new IntegrationContractError("Пакет нельзя запустить до успешного canary без ошибок");
    }
    return { queuedCount: await this.repository.enqueueVariationBatch(runId, Math.max(1, Math.min(5_000, limit))) };
  }
}
