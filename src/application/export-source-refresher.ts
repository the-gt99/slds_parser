import type { ProcessingContext, ProductVariantDTO, SourceProductPartDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { SourceAdapterRegistry, SourceProcessorRegistry } from "../core/registry/index.js";
import type {
  SourceProductRecord,
  SourceProductRepository,
  SourceRecord,
  UnitOfWork,
} from "../repositories/index.js";
import { SourcePartCollector } from "./source-part-collector.js";

export class ExportSourceRefresher {
  private readonly collector: SourcePartCollector;

  constructor(
    private readonly sourceProducts: SourceProductRepository,
    unitOfWork: UnitOfWork,
    private readonly adapters: SourceAdapterRegistry,
    private readonly processors: SourceProcessorRegistry,
    currentTime: () => number = Date.now,
  ) {
    this.collector = new SourcePartCollector(sourceProducts, unitOfWork, adapters, currentTime);
  }

  async refresh(source: SourceRecord, product: SourceProductRecord): Promise<readonly ProductVariantDTO[] | null> {
    const adapter = this.adapters.get(source.adapterCode);
    const requestedPartKeys = adapter.exportRefreshPartKeys ?? [];
    if (requestedPartKeys.length === 0) return null;
    const processor = this.processors.get(source.code);
    if (processor.processExportRefresh === undefined) {
      throw new IntegrationContractError(`Source processor ${processor.sourceCode} does not support export refresh`);
    }

    const collected = await this.collector.collect(source, product, requestedPartKeys);

    const savedParts = await this.sourceProducts.listParts(product.id);
    const combinedParts = new Map<string, SourceProductPartDTO>(savedParts.map((part) => [part.partKey, {
      partKey: part.partKey,
      rawPayload: part.rawPayload,
      parsedPayload: part.parsedPayload,
      ...(part.sourceUpdatedAt === null ? {} : { sourceUpdatedAt: part.sourceUpdatedAt }),
      adapterVersion: part.adapterVersion,
    }]));
    for (const part of collected.freshParts) combinedParts.set(part.partKey, part);
    const context: ProcessingContext = {
      source: collected.source,
      sourceProduct: collected.sourceProduct,
      parts: [...combinedParts.values()],
    };
    return (await processor.processExportRefresh(context)).variants;
  }
}
