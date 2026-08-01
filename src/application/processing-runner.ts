import type { JsonValue, SourceDTO, SourceProductDTO, SourceProductPartDTO } from "../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type { SourceProcessorRegistry } from "../core/registry/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type { InternalProductRepository, SourceProductRepository, SourceRepository, TargetRepository, UnitOfWork } from "../repositories/index.js";
import type { ReferenceMappingService } from "../services/index.js";
import type { ProcessProductPayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

export interface ProcessingRunnerRepositories {
  readonly sources: SourceRepository;
  readonly sourceProducts: SourceProductRepository;
  readonly internalProducts: InternalProductRepository;
  readonly targets: TargetRepository;
}

export class ProcessingRunner {
  constructor(
    private readonly repositories: ProcessingRunnerRepositories,
    private readonly unitOfWork: UnitOfWork,
    private readonly processors: SourceProcessorRegistry,
    private readonly mappings: ReferenceMappingService,
  ) {}

  async processProduct(payload: ProcessProductPayload): Promise<RunnerResult> {
    const product = await this.repositories.sourceProducts.getById(payload.sourceProductId);
    if (product === null) throw new EntityNotFoundError("Source product", payload.sourceProductId);
    const source = await this.repositories.sources.getById(product.sourceId);
    if (source === null) throw new EntityNotFoundError("Source", product.sourceId);
    const parts = await this.repositories.sourceProducts.listParts(product.id);
    const processor = this.processors.get(source.code);
    const inputHash = hashStableJson({ processorVersion: processor.version, parts: parts.map((part) => ({ partKey: part.partKey, contentHash: part.contentHash })).sort((a, b) => a.partKey.localeCompare(b.partKey)) });
    const existing = await this.repositories.internalProducts.findBySourceProductId(product.id);
    if (!payload.force && existing?.inputHash === inputHash) return { status: "skipped" };

    const sourceDto: SourceDTO = { id: source.id, code: source.code, config: source.config };
    const productDto: SourceProductDTO = { id: product.id, sourceId: product.sourceId, sourceKey: product.sourceKey,
      ...(product.externalId === null ? {} : { externalId: product.externalId }), ...(product.slug === null ? {} : { slug: product.slug }),
      ...(product.url === null ? {} : { url: product.url }), metadata: product.discoveryMetadata };
    const partDtos: SourceProductPartDTO[] = parts.map((part) => ({ partKey: part.partKey, rawPayload: part.rawPayload, parsedPayload: part.parsedPayload,
      ...(part.sourceUpdatedAt === null ? {} : { sourceUpdatedAt: part.sourceUpdatedAt }), adapterVersion: part.adapterVersion }));
    const data = await processor.process({ source: sourceDto, sourceProduct: productDto, parts: partDtos,
      references: { resolveReference: (input) => this.mappings.resolveSourceValue(source.id, input.referenceType, input.scope, input.sourceValue) } });
    if (data.sourceProductId !== product.id) throw new IntegrationContractError(`Processed sourceProductId does not match ${product.id}`);
    const contentHash = hashStableJson(data as unknown as JsonValue);
    const targets = await this.repositories.targets.listEnabled();
    await this.unitOfWork.transaction(async (repositories) => {
      const internal = await repositories.internalProducts.upsert({ sourceProductId: product.id, data, inputHash, contentHash,
        processorVersion: processor.version, status: "processed", processedAt: new Date().toISOString(), lastError: null });
      if (existing?.contentHash !== contentHash) {
        for (const target of targets) await repositories.jobs.enqueue({ jobType: "export_product",
          payload: { internalProductId: internal.id, targetId: target.id, force: false }, uniqueKey: `internal-product:${internal.id}:target:${target.id}:export` });
      }
    });
    return { status: "completed" };
  }
}
