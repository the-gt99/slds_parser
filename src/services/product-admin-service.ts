import type { EntityId, ProductImageDTO, ProductVariantDTO } from "../contracts/index.js";
import { EntityNotFoundError } from "../core/errors/index.js";
import type { TargetDictionaryProviderRegistry } from "../integrations/index.js";
import type { InternalProductRecord, ProductAdminRepository, TargetRecord } from "../repositories/index.js";
import type { ProductOperationRegistry } from "../core/registry/index.js";

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

export class ProductAdminService {
  constructor(
    private readonly repository: ProductAdminRepository,
    private readonly providers: TargetDictionaryProviderRegistry,
    private readonly operations?: ProductOperationRegistry,
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

  async getProduct(sourceProductId: EntityId) {
    const snapshot = await this.repository.getById(sourceProductId);
    if (snapshot === null) throw new EntityNotFoundError("Source product", sourceProductId);
    const internal = snapshot.internalProduct;

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
        observations: snapshot.classifications,
        statusCounts: statusCounts(snapshot.classifications),
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
