import type { EntityId, JsonObject } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { ExportControlFilter, ExportControlListQuery, ExportControlRepository, JobRepository } from "../repositories/index.js";

const maximumPreflightBatch = 100;
const maximumExportBatch = 5_000;
const maximumCampaignExports = 200_000;

function uniqueIds(values: readonly EntityId[] | undefined): readonly EntityId[] | undefined {
  return values === undefined ? undefined : [...new Set(values)];
}

function filterJson(filter: ExportControlFilter | undefined, sourceProductIds: readonly EntityId[] | undefined): JsonObject {
  return {
    ...(filter?.status === undefined ? {} : { status: filter.status }),
    ...(filter?.operation === undefined ? {} : { operation: filter.operation }),
    ...(filter?.riskLevel === undefined ? {} : { riskLevel: filter.riskLevel }),
    ...(filter?.changeFlag === undefined ? {} : { changeFlag: filter.changeFlag }),
    ...(filter?.search === undefined ? {} : { search: filter.search }),
    ...(sourceProductIds === undefined ? {} : { sourceProductIds }),
  };
}

export class ExportControlService {
  constructor(private readonly repository: ExportControlRepository, private readonly jobs: JobRepository) {}

  list(query: ExportControlListQuery) {
    return this.repository.list(query);
  }

  async enqueuePreflights(input: {
    readonly targetId: EntityId;
    readonly sourceProductIds?: readonly EntityId[];
    readonly mode?: "all" | "stale";
    readonly limit?: number;
  }) {
    const sourceProductIds = uniqueIds(input.sourceProductIds);
    if (sourceProductIds !== undefined && sourceProductIds.length > maximumPreflightBatch) {
      throw new IntegrationContractError(`За один раз можно проверить не более ${maximumPreflightBatch} товаров`);
    }
    const requestedLimit = input.limit ?? maximumPreflightBatch;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new IntegrationContractError("Нужно выбрать хотя бы один товар для preflight");
    }
    const limit = Math.min(maximumPreflightBatch, requestedLimit);
    const candidates = await this.repository.preparePreflightCandidates({
      targetId: input.targetId,
      ...(sourceProductIds === undefined ? {} : { sourceProductIds }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      limit,
    });
    try {
      const jobs = await this.jobs.enqueueMany(candidates.map((candidate) => ({
        jobType: "preflight_product" as const,
        payload: {
          sourceProductId: candidate.sourceProductId,
          targetId: input.targetId,
          refreshWordPress: candidate.refreshWordPress !== false,
        },
        uniqueKey: `target-product:${input.targetId}:${candidate.sourceProductId}:preflight`,
      })));
      return { queuedCount: jobs.length, sourceProductIds: candidates.map((item) => item.sourceProductId), jobIds: jobs.map((job) => job.id) };
    } catch (error) {
      await Promise.allSettled(candidates.map((candidate) => this.repository.savePreflightError({
        targetId: input.targetId,
        sourceProductId: candidate.sourceProductId,
        error: error instanceof Error ? error.message : String(error),
      })));
      throw error;
    }
  }

  async previewExport(input: { readonly targetId: EntityId; readonly sourceProductIds?: readonly EntityId[]; readonly filter?: ExportControlFilter }) {
    const sourceProductIds = uniqueIds(input.sourceProductIds);
    if (sourceProductIds !== undefined && sourceProductIds.length > maximumExportBatch) {
      throw new IntegrationContractError(`За один запуск можно выбрать не более ${maximumExportBatch} товаров`);
    }
    const candidates = await this.repository.listExportCandidates({
      targetId: input.targetId,
      ...(sourceProductIds === undefined ? {} : { sourceProductIds }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      limit: maximumExportBatch + 1,
    });
    const truncated = candidates.length > maximumExportBatch;
    const selected = candidates.slice(0, maximumExportBatch);
    const risks = { none: 0, review: 0, danger: 0 };
    let creates = 0;
    let updates = 0;
    for (const item of selected) {
      risks[item.riskLevel] += 1;
      if (item.willCreate) creates += 1;
      else updates += 1;
    }
    return {
      eligibleCount: selected.length,
      skippedCount: sourceProductIds === undefined ? 0 : Math.max(0, sourceProductIds.length - selected.length),
      creates, updates, risks, truncated, maximumBatchSize: maximumExportBatch,
      sampleSourceProductIds: selected.slice(0, 10).map((item) => item.sourceProductId),
    };
  }

  async applyExport(input: {
    readonly targetId: EntityId;
    readonly sourceProductIds?: readonly EntityId[];
    readonly filter?: ExportControlFilter;
    readonly reason?: string;
  }, actor: string) {
    const sourceProductIds = uniqueIds(input.sourceProductIds);
    if (sourceProductIds !== undefined && sourceProductIds.length > maximumExportBatch) {
      throw new IntegrationContractError(`За один запуск можно выбрать не более ${maximumExportBatch} товаров`);
    }
    const candidates = await this.repository.listExportCandidates({
      targetId: input.targetId,
      ...(sourceProductIds === undefined ? {} : { sourceProductIds }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      limit: maximumExportBatch + 1,
    });
    if (candidates.length > maximumExportBatch) throw new IntegrationContractError(`Фильтр выбрал больше ${maximumExportBatch} товаров; сузьте выборку`);
    if (sourceProductIds !== undefined && candidates.length !== sourceProductIds.length) {
      throw new IntegrationContractError("Часть выбранных товаров уже не готова; обновите список и повторите проверку");
    }
    const batch = await this.repository.createBatch({
      targetId: input.targetId,
      filter: filterJson(input.filter, sourceProductIds),
      actor,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      candidates,
    });
    return { batchId: batch.batchId, queuedCount: batch.jobIds.length, jobIds: batch.jobIds };
  }

  listBatches(targetId: EntityId, limit: number) {
    return this.repository.listBatches(targetId, limit);
  }

  listCampaigns(targetId: EntityId, limit: number) {
    return this.repository.listCampaigns(targetId, limit);
  }

  listCampaignItems(campaignId: EntityId, limit: number) {
    return this.repository.listCampaignItems(campaignId, limit);
  }

  async startCampaign(input: {
    readonly targetId: EntityId;
    readonly preflightWindow?: number;
    readonly maxExports?: number;
    readonly reason?: string;
  }, actor: string) {
    const preflightWindow = input.preflightWindow ?? 100;
    if (!Number.isInteger(preflightWindow) || preflightWindow < 1 || preflightWindow > maximumPreflightBatch) {
      throw new IntegrationContractError(`Окно preflight должно быть от 1 до ${maximumPreflightBatch}`);
    }
    if (input.maxExports !== undefined
      && (!Number.isInteger(input.maxExports) || input.maxExports < 1 || input.maxExports > maximumCampaignExports)) {
      throw new IntegrationContractError(`Лимит выгрузки должен быть от 1 до ${maximumCampaignExports}`);
    }
    return this.repository.createCampaign({
      targetId: input.targetId,
      actor,
      preflightWindow,
      ...(input.maxExports === undefined ? {} : { maxExports: input.maxExports }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }

  pauseCampaign(campaignId: EntityId) {
    return this.repository.setCampaignStatus({ campaignId, status: "paused" });
  }

  resumeCampaign(campaignId: EntityId) {
    return this.repository.setCampaignStatus({ campaignId, status: "running" });
  }

  async tickCampaign(): Promise<boolean> {
    const campaign = await this.repository.getRunningCampaign();
    if (campaign === null) return false;
    if (campaign.failedCount > campaign.acknowledgedFailedCount) {
      await this.repository.setCampaignStatus({
        campaignId: campaign.id,
        status: "paused",
        error: "Выгрузка остановлена после ошибки товара. Проверьте журнал и возобновите вручную.",
      });
      return true;
    }
    const exportActive = campaign.pendingCount + campaign.runningCount;
    const limitReached = campaign.maxExports !== null && campaign.itemCount >= campaign.maxExports;
    if (limitReached && exportActive === 0) {
      await this.repository.setCampaignStatus({ campaignId: campaign.id, status: "completed" });
      return true;
    }

    let queuedExport = false;
    if (exportActive === 0 && !limitReached) {
      const candidates = await this.repository.listExportCandidates({
        targetId: campaign.targetId,
        filter: { status: "ready", operation: "update", riskLevel: "none" },
        limit: 1,
        campaignId: campaign.id,
        excludeNoChanges: true,
      });
      const candidate = candidates[0];
      if (candidate !== undefined) {
        if (candidate.willCreate || candidate.riskLevel !== "none") {
          throw new IntegrationContractError("Кампания получила товар вне безопасного фильтра");
        }
        await this.repository.createBatch({
          targetId: campaign.targetId,
          filter: { status: "ready", operation: "update", riskLevel: "none" },
          actor: campaign.actor,
          reason: campaign.reason ?? `Безопасная выгрузка #${campaign.id}`,
          candidates: [candidate],
          campaignId: campaign.id,
        });
        queuedExport = true;
      }
    }

    const activePreflights = await this.repository.countActivePreflights(campaign.targetId);
    let queuedPreflights = 0;
    if (activePreflights < campaign.preflightWindow && !limitReached && !campaign.scanComplete) {
      const candidates = await this.repository.prepareCampaignPreflightCandidates({
        campaignId: campaign.id,
        limit: campaign.preflightWindow - activePreflights,
      });
      try {
        const jobs = await this.jobs.enqueueMany(candidates.map((candidate) => ({
          jobType: "preflight_product" as const,
          payload: {
            sourceProductId: candidate.sourceProductId,
            targetId: campaign.targetId,
            refreshWordPress: candidate.refreshWordPress !== false,
          },
          uniqueKey: `target-product:${campaign.targetId}:${candidate.sourceProductId}:preflight`,
        })));
        queuedPreflights = jobs.length;
      } catch (error) {
        await Promise.allSettled(candidates.map((candidate) => this.repository.savePreflightError({
          targetId: campaign.targetId,
          sourceProductId: candidate.sourceProductId,
          error: error instanceof Error ? error.message : String(error),
        })));
        throw error;
      }
    }

    if (!queuedExport && exportActive === 0 && queuedPreflights === 0) {
      const refreshedActive = await this.repository.countActivePreflights(campaign.targetId);
      if (refreshedActive === 0) {
        const refreshedCampaign = await this.repository.getRunningCampaign();
        const remaining = await this.repository.listExportCandidates({
          targetId: campaign.targetId,
          filter: { status: "ready", operation: "update", riskLevel: "none" },
          limit: 1,
          campaignId: campaign.id,
          excludeNoChanges: true,
        });
        if (remaining.length === 0 && refreshedCampaign?.id === campaign.id && refreshedCampaign.scanComplete) {
          await this.repository.setCampaignStatus({ campaignId: campaign.id, status: "completed" });
        }
      }
    }
    return queuedExport || queuedPreflights > 0;
  }
}
