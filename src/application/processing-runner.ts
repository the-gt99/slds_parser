import type { JsonValue, SourceDTO, SourceProductDTO, SourceProductPartDTO, UniversalProductDTO } from "../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type { SourceProcessorRegistry } from "../core/registry/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type { InternalProductRepository, SourceProductRepository, SourceRepository, TargetRepository, UnitOfWork } from "../repositories/index.js";
import type { ProductClassifier, ProductClassifierRun } from "../services/index.js";
import type { ProcessProductPayload } from "./job-payloads.js";
import type { ReclassifyProductPayload } from "./job-payloads.js";
import type { ProductOperationPipeline } from "./product-operation-pipeline.js";
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
    private readonly operations: ProductOperationPipeline,
    private readonly classifier: Pick<ProductClassifier, "classify" | "version">,
  ) {}

  async processProduct(payload: ProcessProductPayload): Promise<RunnerResult> {
    const product = await this.repositories.sourceProducts.getById(payload.sourceProductId);
    if (product === null) throw new EntityNotFoundError("Source product", payload.sourceProductId);
    const source = await this.repositories.sources.getById(product.sourceId);
    if (source === null) throw new EntityNotFoundError("Source", product.sourceId);
    const parts = await this.repositories.sourceProducts.listParts(product.id);
    const processor = this.processors.get(source.code);
    const inputHash = hashStableJson({
      processorVersion: processor.version,
      operations: this.operations.fingerprint(source.code),
      source: { code: source.code, config: source.config },
      sourceProduct: {
        sourceKey: product.sourceKey,
        externalId: product.externalId,
        slug: product.slug,
        url: product.url,
        metadata: product.discoveryMetadata,
      },
      parts: parts
        .map((part) => ({
          partKey: part.partKey,
          contentHash: part.contentHash,
        }))
        .sort((a, b) => a.partKey.localeCompare(b.partKey)),
    });
    const sourceDto: SourceDTO = { id: source.id, code: source.code, config: source.config };
    const productDto: SourceProductDTO = { id: product.id, sourceId: product.sourceId, sourceKey: product.sourceKey,
      ...(product.externalId === null ? {} : { externalId: product.externalId }), ...(product.slug === null ? {} : { slug: product.slug }),
      ...(product.url === null ? {} : { url: product.url }), metadata: product.discoveryMetadata };
    const existing = await this.repositories.internalProducts.findBySourceProductId(product.id);
    let classificationRun: ProductClassifierRun;
    let attemptId: string | null = null;
    let operationsOutput: UniversalProductDTO | null = null;
    if (!payload.force && existing?.inputHash === inputHash) {
      classificationRun = await this.classifier.classify(source.id, existing.data);
      const reclassifiedHash = hashStableJson(classificationRun.product as unknown as JsonValue);
      if (existing.contentHash === reclassifiedHash) return { status: "skipped" };
    } else {
      const partDtos: SourceProductPartDTO[] = parts.map((part) => ({ partKey: part.partKey, rawPayload: part.rawPayload, parsedPayload: part.parsedPayload,
      ...(part.sourceUpdatedAt === null ? {} : { sourceUpdatedAt: part.sourceUpdatedAt }), adapterVersion: part.adapterVersion }));
      const baseProduct = await processor.process({ source: sourceDto, sourceProduct: productDto, parts: partDtos });
      if (baseProduct.sourceProductId !== product.id) throw new IntegrationContractError(`Processed sourceProductId does not match ${product.id}`);
      const operationRun = await this.operations.runTracked(baseProduct, {
        source: sourceDto,
        sourceProduct: productDto,
        ...(existing === null ? {} : { previousProduct: existing.data }),
      }, processor.version);
      attemptId = operationRun.attemptId;
      operationsOutput = operationRun.product;
      try {
        classificationRun = await this.classifier.classify(source.id, operationRun.product);
      } catch (error) {
        await this.operations.failAttempt(operationRun.attemptId, error);
        throw error;
      }
    }
    const data = classificationRun.product;
    try {
      const contentHash = hashStableJson(data as unknown as JsonValue);
      const targets = await this.repositories.targets.listEnabled();
      await this.unitOfWork.transaction(async (repositories) => {
        const internal = await repositories.internalProducts.upsert({ sourceProductId: product.id, data, inputHash, contentHash,
          processorVersion: processor.version, status: data.classification.status === "complete" ? "classified" : "classification_pending",
          processedAt: new Date().toISOString(), lastError: null });
        await repositories.classifications.saveProductResult({
          sourceId: source.id,
          sourceProductId: product.id,
          processorVersion: processor.classificationVersion,
          classifierVersion: this.classifier.version,
          fingerprint: data.classification.fingerprint,
          observations: classificationRun.observations,
        });
        if (attemptId !== null && operationsOutput !== null) {
          await repositories.productOperationHistory.completeAttempt(attemptId, operationsOutput, classificationRun.product, new Date().toISOString());
        }
        if ((data.classification.status === "complete" || data.classification.execution?.mode === "v2") && existing?.contentHash !== contentHash) {
          for (const target of targets) await repositories.jobs.enqueue({ jobType: "export_product",
            payload: { internalProductId: internal.id, targetId: target.id, force: false }, uniqueKey: `internal-product:${internal.id}:target:${target.id}:export` });
        }
      });
    } catch (error) {
      if (attemptId !== null) await this.operations.failAttempt(attemptId, error);
      throw error;
    }
    return { status: "completed" };
  }

  async reclassifyProduct(payload: ReclassifyProductPayload): Promise<RunnerResult> {
    const product = await this.repositories.sourceProducts.getById(payload.sourceProductId);
    if (product === null) throw new EntityNotFoundError("Source product", payload.sourceProductId);
    const source = await this.repositories.sources.getById(product.sourceId);
    if (source === null) throw new EntityNotFoundError("Source", product.sourceId);
    const existing = await this.repositories.internalProducts.findBySourceProductId(product.id);
    if (existing === null) throw new EntityNotFoundError("Internal product for source product", product.id);

    const processor = this.processors.get(source.code);
    const classificationRun = await this.classifier.classify(source.id, existing.data);
    const data = classificationRun.product;
    const contentHash = hashStableJson(data as unknown as JsonValue);
    if (existing.contentHash === contentHash) return { status: "skipped" };

    const targets = await this.repositories.targets.listEnabled();
    await this.unitOfWork.transaction(async (repositories) => {
      const internal = await repositories.internalProducts.upsert({
        sourceProductId: product.id,
        data,
        inputHash: existing.inputHash,
        contentHash,
        processorVersion: existing.processorVersion,
        status: data.classification.status === "complete" ? "classified" : "classification_pending",
        processedAt: existing.processedAt,
        lastError: null,
      });
      await repositories.classifications.saveProductResult({
        sourceId: source.id,
        sourceProductId: product.id,
        processorVersion: processor.classificationVersion,
        classifierVersion: this.classifier.version,
        fingerprint: data.classification.fingerprint,
        observations: classificationRun.observations,
      });
      if (data.classification.status === "complete" || data.classification.execution?.mode === "v2") {
        for (const target of targets) await repositories.jobs.enqueue({
          jobType: "export_product",
          payload: { internalProductId: internal.id, targetId: target.id, force: false },
          uniqueKey: `internal-product:${internal.id}:target:${target.id}:export`,
        });
      }
    });
    return { status: "completed" };
  }
}
