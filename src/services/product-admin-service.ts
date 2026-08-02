import type { EntityId, ProductImageDTO, ProductVariantDTO } from "../contracts/index.js";
import { EntityNotFoundError } from "../core/errors/index.js";
import type { TargetDictionaryProviderRegistry } from "../integrations/index.js";
import type { InternalProductRecord, ProductAdminRepository, TargetRecord } from "../repositories/index.js";

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

function statusCounts(values: readonly { readonly status: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value.status] = (counts[value.status] ?? 0) + 1;
  return counts;
}

export class ProductAdminService {
  constructor(
    private readonly repository: ProductAdminRepository,
    private readonly providers: TargetDictionaryProviderRegistry,
  ) {}

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
        operations: snapshot.operations,
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
        return {
          id: target.id,
          code: target.code,
          name: target.name,
          exporterCode: target.exporterCode,
          status: product?.status ?? "not_exported",
          externalId: product?.externalId ?? null,
          editUrl,
          lastAttemptAt: product?.lastAttemptAt ?? null,
          syncedAt: product?.syncedAt ?? null,
          lastError: product?.lastError ?? null,
        };
      }),
    };
  }
}
