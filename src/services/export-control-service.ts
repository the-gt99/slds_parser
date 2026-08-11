import type { EntityId, JsonObject } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { ExportControlFilter, ExportControlListQuery, ExportControlRepository, JobRepository } from "../repositories/index.js";

const maximumPreflightBatch = 100;
const maximumExportBatch = 5_000;

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

  async enqueuePreflights(input: { readonly targetId: EntityId; readonly sourceProductIds?: readonly EntityId[]; readonly limit?: number }) {
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
      limit,
    });
    try {
      const jobs = await this.jobs.enqueueMany(candidates.map((candidate) => ({
        jobType: "collect_product" as const,
        payload: { sourceProductId: candidate.sourceProductId, refreshForExport: true, enqueueProcessing: true },
        uniqueKey: `source-product:${candidate.sourceProductId}:collect`,
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
}
