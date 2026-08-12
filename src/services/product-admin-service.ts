import { statfs } from "node:fs/promises";

import type { EntityId, JsonValue, ProductImageDTO, ProductVariantDTO } from "../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type { TargetDictionaryProviderRegistry } from "../integrations/index.js";
import type {
  InternalProductRecord,
  JobRepository,
  JobType,
  ProductAdminRepository,
  ProductBatchAction,
  ProductBatchCandidate,
  ProductBatchDryRun,
  ProductBatchFilter,
  TargetRecord,
} from "../repositories/index.js";
import type { ProductOperationRegistry } from "../core/registry/index.js";
import type { ProductClassifier } from "./product-classifier.js";

function providerCode(target: TargetRecord): string {
  const configured = target.config.dictionaryProviderCode;
  return typeof configured === "string" && configured.trim() !== ""
    ? configured.trim()
    : target.exporterCode;
}

function publicImage(image: ProductImageDTO) {
  return {
    url: image.url,
    sourceUrl: image.sourceUrl ?? null,
    position: image.position,
    alt: image.alt,
    mimeType: image.mimeType ?? null,
    storedFormat: image.storedFormat ?? null,
    width: image.width ?? null,
    height: image.height ?? null,
    sourceContentHash: image.sourceContentHash ?? null,
    contentHash: image.contentHash ?? null,
    perceptualHash: image.perceptualHash ?? null,
    attributes: image.attributes,
  };
}

function publicVariant(variant: ProductVariantDTO) {
  return {
    sourceVariantKey: variant.sourceVariantKey,
    sku: variant.sku,
    size: variant.size,
    price: variant.price,
    inventory: variant.inventory,
    attributes: variant.attributes,
  };
}

function publicProduct(internal: InternalProductRecord) {
  const data = internal.data;
  return {
    internalProductId: internal.id,
    status: internal.status,
    title: data.title,
    description: data.description,
    sku: data.sku,
    attributes: data.attributes,
    metadata: data.metadata,
    images: data.images.map(publicImage),
    variants: data.variants.map(publicVariant),
    classification: data.classification,
    processorVersion: internal.processorVersion,
    processedAt: internal.processedAt,
    lastError: internal.lastError,
    createdAt: internal.createdAt,
    updatedAt: internal.updatedAt,
  };
}

function publicDto(data: InternalProductRecord["data"] | null) {
  if (data === null) return null;
  return {
    ...data,
    images: data.images.map(publicImage),
    variants: data.variants.map(publicVariant),
  };
}

function statusCounts(values: readonly { readonly status: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value.status] = (counts[value.status] ?? 0) + 1;
  return counts;
}

const activeExportStatuses = ["running", "retry", "pending"] as const;
const activeJobStatuses = new Set(["running", "retry", "pending"]);
const defaultMediaBytesPerImage = 2_500_000;

function assertBatchAction(value: ProductBatchAction): void {
  if (!["collect", "collect_and_process", "process", "reprocess", "retry_failed_processing", "export"].includes(value)) {
    throw new IntegrationContractError(`Unsupported batch action: ${value}`);
  }
  if (value === "export") {
    throw new IntegrationContractError("Mass export is intentionally disabled while the target is off and business blockers are unresolved");
  }
}

function jobPayload(sourceProductId: EntityId, action: ProductBatchAction) {
  if (action === "collect") return { sourceProductId, enqueueProcessing: false };
  if (action === "collect_and_process") return { sourceProductId, enqueueProcessing: true };
  if (action === "process") return { sourceProductId, force: false };
  return { sourceProductId, force: true };
}

function jobTypeForAction(action: ProductBatchAction): JobType {
  return action === "collect" || action === "collect_and_process" ? "collect_product" : "process_product";
}

function skipReason(action: ProductBatchAction, item: ProductBatchCandidate): string | null {
  if ((action === "collect" || action === "collect_and_process") && item.activeCollectJobId !== null) return "Уже есть активная задача сбора";
  if (action === "process" && item.activeProcessJobId !== null) return "Уже есть активная задача обработки";
  if (action === "process" && item.stage === "discovered") return "Товар ещё не собран";
  if (action === "reprocess" && item.activeProcessJobId !== null) return "Уже есть активная задача обработки";
  if (action === "reprocess" && item.internalProductId === null && item.stage === "discovered") return "Товар ещё не собран";
  if (action === "retry_failed_processing" && item.activeProcessJobId !== null) return "Уже есть активная задача обработки";
  if (action === "retry_failed_processing" && item.failedProcessJobId === null) return "Нет завершившейся ошибкой задачи обработки";
  return null;
}

function countReasons(reasons: readonly string[]) {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}

async function diskInfo(estimatedImages: number) {
  try {
    const stats = await statfs(process.cwd());
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const estimatedBytes = estimatedImages * defaultMediaBytesPerImage;
    return {
      availableBytes,
      warning: estimatedBytes > availableBytes * 0.8
        ? "Пачка может не поместиться по грубой оценке media; уменьшите limit или освободите диск."
        : null,
    };
  } catch {
    return { availableBytes: null, warning: "Не удалось проверить свободное место на диске." };
  }
}

function redactJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value !== null && typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = /(token|secret|password|cookie|credential|authorization|bearer)/iu.test(key)
        ? "[hidden]"
        : redactJson(entry as JsonValue);
    }
    return output;
  }
  if (typeof value === "string" && /(Bearer\s+[A-Za-z0-9._-]+|wordpress[_-]?import[_-]?token|cf_clearance=)/iu.test(value)) {
    return "[hidden]";
  }
  return value;
}

export class ProductAdminService {
  constructor(
    private readonly repository: ProductAdminRepository,
    private readonly providers: TargetDictionaryProviderRegistry,
    private readonly operations?: ProductOperationRegistry,
    private readonly jobs?: JobRepository,
    private readonly classifier?: ProductClassifier,
  ) {}

  listProducts(query: Parameters<NonNullable<ProductAdminRepository["listProducts"]>>[0]) {
    if (this.repository.listProducts === undefined) throw new Error("Product list is not configured");
    return this.repository.listProducts(query);
  }

  async listSnapshots(query: Parameters<NonNullable<ProductAdminRepository["listSnapshots"]>>[0]) {
    if (this.repository.listSnapshots === undefined) throw new Error("Snapshot list is not configured");
    const result = await this.repository.listSnapshots(query);
    return {
      ...result,
      items: result.items.map(({ payload: _payload, ...item }) => {
        const provider = this.providers.find(item.targetCode === "slamdunk" ? "wordpress" : item.targetCode);
        return {
          ...item,
          editUrl: provider?.productEditUrl?.(item.externalId) ?? null,
          publicUrl: provider?.productPublicUrl?.(item.externalId) ?? null,
        };
      }),
    };
  }

  listOperations() {
    return (this.operations?.list() ?? []).map((operation) => ({
      code: operation.code,
      name: operation.name ?? operation.code,
      version: operation.version,
      dependsOn: operation.dependsOn ?? [],
      sourceCodes: operation.sourceCodes ?? null,
    }));
  }

  async previewBatch(input: { readonly action: ProductBatchAction; readonly filter: ProductBatchFilter; readonly force?: boolean }): Promise<ProductBatchDryRun> {
    assertBatchAction(input.action);
    if (this.repository.listBatchCandidates === undefined) throw new Error("Product batch actions are not configured");
    const force = input.action === "reprocess" || input.action === "retry_failed_processing" || input.force === true;
    const filter = { ...input.filter, includeFailedProcessing: input.action === "retry_failed_processing" };
    const selected = await this.repository.listBatchCandidates(filter);
    const skipped: string[] = [];
    const eligible: ProductBatchCandidate[] = [];
    let activeDuplicateCount = 0;
    for (const item of selected.items) {
      const reason = skipReason(input.action, item);
      if (reason !== null) {
        skipped.push(reason);
        if (reason.startsWith("Уже есть активная")) activeDuplicateCount += 1;
      } else {
        eligible.push(item);
      }
    }
    const estimatedImages = eligible.reduce((sum, item) => sum + item.imageCount, 0);
    return {
      action: input.action,
      selectedCount: selected.total,
      eligibleCount: eligible.length,
      skippedCount: skipped.length + Math.max(0, selected.total - selected.items.length),
      activeDuplicateCount,
      jobsToCreate: eligible.length,
      force,
      enqueueProcessing: input.action === "collect" ? false : input.action === "collect_and_process" ? true : null,
      skipReasons: [
        ...countReasons(skipped),
        ...(selected.total > selected.items.length ? [{ reason: "Сверх выбранного server-side limit", count: selected.total - selected.items.length }] : []),
      ],
      sampleProductIds: eligible.slice(0, 10).map((item) => item.sourceProductId),
      estimatedImages,
      disk: await diskInfo(estimatedImages),
    };
  }

  async applyBatch(input: { readonly action: ProductBatchAction; readonly filter: ProductBatchFilter; readonly force?: boolean; readonly reason?: string }, actor: string) {
    assertBatchAction(input.action);
    if (this.repository.listBatchCandidates === undefined || this.repository.saveBatchAudit === undefined || this.jobs === undefined) {
      throw new Error("Product batch actions are not configured");
    }
    const dryRun = await this.previewBatch(input);
    const selected = await this.repository.listBatchCandidates({ ...input.filter, includeFailedProcessing: input.action === "retry_failed_processing" });
    const eligible = selected.items.filter((item) => skipReason(input.action, item) === null);
    const jobType = jobTypeForAction(input.action);
    const jobs = await this.jobs.enqueueMany(eligible.map((item) => ({
        jobType,
        payload: jobPayload(item.sourceProductId, input.action),
        uniqueKey: `source-product:${item.sourceProductId}:${jobType === "collect_product" ? "collect" : "process"}`,
    })));
    const createdJobIds = jobs.filter((job) => activeJobStatuses.has(job.status)).map((job) => job.id);
    const auditId = await this.repository.saveBatchAudit({
      action: input.action,
      filter: input.filter,
      dryRun,
      createdJobIds,
      actor,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return { ...dryRun, auditId, createdJobIds };
  }

  async listJobs(query: Parameters<NonNullable<ProductAdminRepository["listJobs"]>>[0]) {
    if (this.repository.listJobs === undefined) throw new Error("Job admin list is not configured");
    const result = await this.repository.listJobs(query);
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, payload: redactJson(item.payload) })),
    };
  }

  async previewFailedJobRetry(jobType: JobType, limit: number) {
    if (jobType === "export_product") throw new IntegrationContractError("Export retry is disabled from this administrative action");
    if (this.repository.previewFailedJobRetry === undefined) throw new Error("Failed job retry is not configured");
    return this.repository.previewFailedJobRetry(jobType, limit);
  }

  async retryFailedJobs(jobType: JobType, limit: number, actor: string, reason?: string) {
    if (jobType === "export_product") throw new IntegrationContractError("Export retry is disabled from this administrative action");
    if (this.repository.previewFailedJobRetry === undefined || this.repository.listFailedJobRetryIds === undefined || this.repository.saveBatchAudit === undefined || this.jobs === undefined) {
      throw new Error("Failed job retry is not configured");
    }
    const preview = await this.repository.previewFailedJobRetry(jobType, limit);
    const ids = await this.repository.listFailedJobRetryIds(jobType, limit);
    for (const id of ids) {
      await this.jobs.retry(id, { availableAt: new Date().toISOString(), error: `Повтор запрошен администратором ${actor}` });
    }
    const auditId = await this.repository.saveBatchAudit({
      action: "retry_failed_processing",
      filter: { limit },
      dryRun: {
        action: "retry_failed_processing",
        selectedCount: preview.failedCount,
        eligibleCount: ids.length,
        skippedCount: preview.failedCount - ids.length,
        activeDuplicateCount: preview.activeDuplicateCount,
        jobsToCreate: 0,
        force: false,
        enqueueProcessing: null,
        skipReasons: preview.activeDuplicateCount > 0 ? [{ reason: "Уже есть активный дубль", count: preview.activeDuplicateCount }] : [],
        sampleProductIds: [],
        estimatedImages: 0,
        disk: { availableBytes: null, warning: null },
      },
      createdJobIds: ids,
      actor,
      ...(reason === undefined ? {} : { reason }),
    });
    return { ...preview, retriedJobIds: ids, auditId };
  }

  async getProduct(sourceProductId: EntityId) {
    const snapshot = await this.repository.getById(sourceProductId);
    if (snapshot === null) throw new EntityNotFoundError("Source product", sourceProductId);
    const internal = snapshot.internalProduct;
    const hasPendingProcessing = snapshot.jobs.some((job) => ["process_product", "reclassify_product"].includes(job.jobType) && activeJobStatuses.has(job.status));
    const pendingResolutions = new Map<string, {
      readonly status: "resolved" | "ignored" | "unresolved" | "ambiguous";
      readonly resolutionKind: "mapping" | "rule" | null;
      readonly resolutionId: EntityId | null;
    }>();
    if (hasPendingProcessing && internal !== null && this.classifier !== undefined) {
      const current = await this.classifier.classify(snapshot.source.id, internal.data);
      for (const observation of current.observations) {
        pendingResolutions.set(observation.candidate.key, {
          status: observation.status,
          resolutionKind: observation.resolutionKind,
          resolutionId: observation.resolutionId,
        });
      }
    }
    const classifications = snapshot.classifications.map((observation) => {
      const pending = pendingResolutions.get(observation.candidateKey);
      const changed = pending !== undefined && (
        pending.status !== observation.status
        || pending.resolutionKind !== observation.resolutionKind
        || pending.resolutionId !== observation.resolutionId
      );
      return { ...observation, pendingResolution: changed ? pending : null };
    });

    return {
      source: {
        id: snapshot.source.id,
        code: snapshot.source.code,
        name: snapshot.source.name,
      },
      sourceProduct: {
        id: snapshot.sourceProduct.id,
        sourceKey: snapshot.sourceProduct.sourceKey,
        externalId: snapshot.sourceProduct.externalId,
        slug: snapshot.sourceProduct.slug,
        donorUrl: snapshot.sourceProduct.url,
        status: snapshot.sourceProduct.status,
        discoveryMetadata: snapshot.sourceProduct.discoveryMetadata,
        firstSeenAt: snapshot.sourceProduct.firstSeenAt,
        lastSeenAt: snapshot.sourceProduct.lastSeenAt,
        createdAt: snapshot.sourceProduct.createdAt,
        updatedAt: snapshot.sourceProduct.updatedAt,
      },
      product: internal === null ? null : publicProduct(internal),
      collection: {
        run: snapshot.lastCollectionRun === null ? null : {
          id: snapshot.lastCollectionRun.id,
          runType: snapshot.lastCollectionRun.runType,
          coverage: snapshot.lastCollectionRun.coverage,
          status: snapshot.lastCollectionRun.status,
          completeness: snapshot.lastCollectionRun.completeness,
          processedCount: snapshot.lastCollectionRun.processedCount,
          discoveredCount: snapshot.lastCollectionRun.discoveredCount,
          errorCount: snapshot.lastCollectionRun.errorCount,
          startedAt: snapshot.lastCollectionRun.startedAt,
          finishedAt: snapshot.lastCollectionRun.finishedAt,
          lastError: snapshot.lastCollectionRun.lastError,
        },
        parts: snapshot.parts,
      },
      processing: {
        currentOutput: internal === null ? null : publicDto(internal.data),
        operations: snapshot.operations.map((operation) => ({
          ...operation,
          outputData: publicDto(operation.outputData),
        })),
        attempts: (snapshot.processingAttempts ?? []).map((attempt) => ({
          ...attempt,
          processorOutput: publicDto(attempt.processorOutput),
          operationsOutput: publicDto(attempt.operationsOutput),
          classifiedOutput: publicDto(attempt.classifiedOutput),
        })),
        statusCounts: statusCounts(snapshot.operations),
      },
      classification: {
        observations: classifications,
        statusCounts: statusCounts(classifications),
      },
      jobs: snapshot.jobs.map((job) => ({
        id: job.id,
        type: job.jobType,
        status: job.status,
        attempts: job.attempts,
        lastError: job.lastError,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
      })),
      targets: snapshot.targets.map(({ target, product }) => {
        const provider = this.providers.find(providerCode(target));
        const editUrl = product?.externalId === null || product?.externalId === undefined
          ? null
          : provider?.productEditUrl?.(product.externalId) ?? null;
        const attempts = snapshot.jobs.filter((job) => {
          if (job.jobType !== "export_product" || job.payload === null || typeof job.payload !== "object" || Array.isArray(job.payload)) return false;
          return String((job.payload as { readonly targetId?: unknown }).targetId ?? "") === target.id;
        });
        const activeExportStatus = activeExportStatuses.find((status) => attempts.some((job) => job.status === status)) ?? null;
        return {
          id: target.id,
          code: target.code,
          name: target.name,
          exporterCode: target.exporterCode,
          status: activeExportStatus === null ? product?.status ?? "not_exported" : "pending",
          activeExportStatus,
          externalId: product?.externalId ?? null,
          editUrl,
          lastAttemptAt: product?.lastAttemptAt ?? null,
          syncedAt: product?.syncedAt ?? null,
          lastError: product?.lastError ?? null,
          attempts: attempts.map((job) => ({ id: job.id, status: job.status, attempts: job.attempts, createdAt: job.createdAt, finishedAt: job.finishedAt, lastError: job.lastError })),
        };
      }),
      wordpressSnapshots: (snapshot.snapshots ?? []).map((item) => {
        const provider = this.providers.find(item.targetCode === "slamdunk" ? "wordpress" : item.targetCode);
        return {
          id: item.id, targetId: item.targetId, targetCode: item.targetCode,
          externalId: item.externalId, sourceExternalId: item.sourceExternalId,
          title: item.title, fetchedAt: item.fetchedAt, payload: item.payload,
          editUrl: provider?.productEditUrl?.(item.externalId) ?? null,
          publicUrl: provider?.productPublicUrl?.(item.externalId) ?? null,
        };
      }),
    };
  }
}
