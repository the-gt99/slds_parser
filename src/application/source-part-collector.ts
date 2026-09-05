import type { SourceDTO, SourceProductDTO, SourceProductPartDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { SourceAdapterRegistry } from "../core/registry/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type { SourceProductRecord, SourceProductRepository, SourceRecord, TransactionRepositories, UnitOfWork } from "../repositories/index.js";

export interface SourcePartCollectionResult {
  readonly source: SourceDTO;
  readonly sourceProduct: SourceProductDTO;
  readonly freshParts: readonly SourceProductPartDTO[];
  readonly changedPartKeys: readonly string[];
}

export class SourcePartCollector {
  constructor(
    private readonly sourceProducts: SourceProductRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly adapters: SourceAdapterRegistry,
    private readonly currentTime: () => number = Date.now,
  ) {}

  async collect(
    source: SourceRecord,
    product: SourceProductRecord,
    requestedPartKeys?: readonly string[],
    afterSave?: (repositories: TransactionRepositories, changedPartKeys: readonly string[]) => Promise<void>,
  ): Promise<SourcePartCollectionResult> {
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
    const adapter = this.adapters.get(source.adapterCode);
    const collected = await adapter.collectProduct({
      source: sourceDto,
      product: productDto,
      ...(requestedPartKeys === undefined ? {} : { requestedPartKeys }),
    });
    if (collected.sourceKey !== product.sourceKey) {
      throw new IntegrationContractError(`Collected sourceKey does not match product ${product.id}`);
    }
    const freshParts = new Map<string, SourceProductPartDTO>();
    for (const part of collected.parts) {
      if (freshParts.has(part.partKey)) throw new IntegrationContractError(`Duplicate collected part: ${part.partKey}`);
      freshParts.set(part.partKey, part);
    }
    for (const partKey of requestedPartKeys ?? []) {
      if (!freshParts.has(partKey)) throw new IntegrationContractError(`Requested part is missing: ${partKey}`);
    }

    const changedPartKeys: string[] = [];
    const fetchedAt = new Date(this.currentTime()).toISOString();
    await this.unitOfWork.transaction(async (repositories) => {
      await repositories.sourceProducts.updateIdentity(product.id, {
        ...(collected.externalId === undefined ? {} : { externalId: collected.externalId }),
        ...(collected.slug === undefined ? {} : { slug: collected.slug }),
        ...(collected.url === undefined ? {} : { url: collected.url }),
      });
      for (const part of freshParts.values()) {
        const saved = await repositories.sourceProducts.upsertPart({
          sourceProductId: product.id,
          partKey: part.partKey,
          rawPayload: part.rawPayload,
          parsedPayload: part.parsedPayload,
          contentHash: hashStableJson(part.parsedPayload),
          ...(part.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: part.sourceUpdatedAt }),
          fetchedAt,
          adapterVersion: part.adapterVersion,
        });
        if (saved.changed) changedPartKeys.push(part.partKey);
      }
      await afterSave?.(repositories, changedPartKeys);
    });
    const refreshedProduct = await this.sourceProducts.getById(product.id);
    if (refreshedProduct === null) throw new IntegrationContractError(`Collected source product disappeared: ${product.id}`);
    return {
      source: sourceDto,
      sourceProduct: {
        id: refreshedProduct.id,
        sourceId: refreshedProduct.sourceId,
        sourceKey: refreshedProduct.sourceKey,
        ...(refreshedProduct.externalId === null ? {} : { externalId: refreshedProduct.externalId }),
        ...(refreshedProduct.slug === null ? {} : { slug: refreshedProduct.slug }),
        ...(refreshedProduct.url === null ? {} : { url: refreshedProduct.url }),
        metadata: refreshedProduct.discoveryMetadata,
      },
      freshParts: [...freshParts.values()],
      changedPartKeys,
    };
  }
}
