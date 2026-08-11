import type {
  ProcessingContext,
  ProductVariantDTO,
  SourceDTO,
  SourceProductDTO,
  SourceProductPartDTO,
} from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { SourceAdapterRegistry, SourceProcessorRegistry } from "../core/registry/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type {
  SourceProductRecord,
  SourceProductRepository,
  SourceRecord,
  UnitOfWork,
} from "../repositories/index.js";

export class ExportSourceRefresher {
  constructor(
    private readonly sourceProducts: SourceProductRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly adapters: SourceAdapterRegistry,
    private readonly processors: SourceProcessorRegistry,
    private readonly currentTime: () => number = Date.now,
  ) {}

  async refresh(source: SourceRecord, product: SourceProductRecord): Promise<readonly ProductVariantDTO[] | null> {
    const adapter = this.adapters.get(source.adapterCode);
    const requestedPartKeys = adapter.exportRefreshPartKeys ?? [];
    if (requestedPartKeys.length === 0) return null;
    const processor = this.processors.get(source.code);
    if (processor.processExportRefresh === undefined) {
      throw new IntegrationContractError(`Source processor ${processor.sourceCode} does not support export refresh`);
    }

    const sourceDto: SourceDTO = { id: source.id, code: source.code, config: source.config };
    const productDto: SourceProductDTO = {
      id: product.id,
      sourceId: product.sourceId,
      sourceKey: product.sourceKey,
      ...(product.externalId === null ? {} : { externalId: product.externalId }),
      ...(product.slug === null ? {} : { slug: product.slug }),
      ...(product.url === null ? {} : { url: product.url }),
      metadata: product.discoveryMetadata,
    };
    const collected = await adapter.collectProduct({
      source: sourceDto,
      product: productDto,
      requestedPartKeys,
    });
    if (collected.sourceKey !== product.sourceKey) {
      throw new IntegrationContractError(`Collected sourceKey does not match product ${product.id}`);
    }
    const freshParts = new Map<string, SourceProductPartDTO>();
    for (const part of collected.parts) {
      if (freshParts.has(part.partKey)) throw new IntegrationContractError(`Duplicate collected part: ${part.partKey}`);
      freshParts.set(part.partKey, part);
    }
    for (const partKey of requestedPartKeys) {
      if (!freshParts.has(partKey)) throw new IntegrationContractError(`Requested part is missing: ${partKey}`);
    }

    const fetchedAt = new Date(this.currentTime()).toISOString();
    await this.unitOfWork.transaction(async (repositories) => {
      await repositories.sourceProducts.updateIdentity(product.id, {
        ...(collected.externalId === undefined ? {} : { externalId: collected.externalId }),
        ...(collected.slug === undefined ? {} : { slug: collected.slug }),
        ...(collected.url === undefined ? {} : { url: collected.url }),
      });
      for (const part of freshParts.values()) {
        await repositories.sourceProducts.upsertPart({
          sourceProductId: product.id,
          partKey: part.partKey,
          rawPayload: part.rawPayload,
          parsedPayload: part.parsedPayload,
          contentHash: hashStableJson(part.parsedPayload),
          ...(part.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: part.sourceUpdatedAt }),
          fetchedAt,
          adapterVersion: part.adapterVersion,
        });
      }
    });

    const savedParts = await this.sourceProducts.listParts(product.id);
    const combinedParts = new Map<string, SourceProductPartDTO>(savedParts.map((part) => [part.partKey, {
      partKey: part.partKey,
      rawPayload: part.rawPayload,
      parsedPayload: part.parsedPayload,
      ...(part.sourceUpdatedAt === null ? {} : { sourceUpdatedAt: part.sourceUpdatedAt }),
      adapterVersion: part.adapterVersion,
    }]));
    for (const part of freshParts.values()) combinedParts.set(part.partKey, part);
    const context: ProcessingContext = {
      source: sourceDto,
      sourceProduct: {
        ...productDto,
        ...(collected.externalId === undefined ? {} : { externalId: collected.externalId }),
        ...(collected.slug === undefined ? {} : { slug: collected.slug }),
        ...(collected.url === undefined ? {} : { url: collected.url }),
      },
      parts: [...combinedParts.values()],
    };
    return (await processor.processExportRefresh(context)).variants;
  }
}
