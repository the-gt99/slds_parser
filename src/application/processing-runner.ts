import type { JsonValue, ProductRulesV2DTO, SourceDTO, SourceProductDTO, SourceProductPartDTO, UniversalProductDTO } from "../contracts/index.js";
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

interface ProcessingDecision {
  readonly mode: "v1" | "v2";
  readonly data: UniversalProductDTO;
  readonly status: "classified" | "classification_pending";
  readonly legacyRun: ProductClassifierRun | null;
}

export class ProcessingRunner {
  constructor(
    private readonly repositories: ProcessingRunnerRepositories,
    private readonly unitOfWork: UnitOfWork,
    private readonly processors: SourceProcessorRegistry,
    private readonly operations: ProductOperationPipeline,
    private readonly classifier: Pick<ProductClassifier, "classify" | "version">,
    private readonly directDecisions?: { decideProduct(source: SourceDTO, sourceProduct: SourceProductDTO,
      product: UniversalProductDTO): Promise<(UniversalProductDTO & { readonly rulesV2: ProductRulesV2DTO }) | null> },
  ) {}

  private async decide(source: SourceDTO, sourceProduct: SourceProductDTO,
    product: UniversalProductDTO): Promise<ProcessingDecision> {
    const direct = await this.directDecisions?.decideProduct(source, sourceProduct, product);
    if (direct !== undefined && direct !== null) return { mode: "v2", data: direct,
      status: direct.rulesV2.status === "complete" ? "classified" : "classification_pending", legacyRun: null };
    const { rulesV2: _rulesV2, ...legacyProduct } = product;
    const legacyRun = await this.classifier.classify(source.id, legacyProduct);
    return { mode: "v1", data: legacyRun.product,
      status: legacyRun.product.classification.status === "complete" ? "classified" : "classification_pending", legacyRun };
  }

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
    let decision: ProcessingDecision;
    let attemptId: string | null = null;
    let operationsOutput: UniversalProductDTO | null = null;
    if (!payload.force && existing?.inputHash === inputHash) {
      decision = await this.decide(sourceDto, productDto, existing.data);
      const reclassifiedHash = hashStableJson(decision.data as unknown as JsonValue);
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
        decision = await this.decide(sourceDto, productDto, operationRun.product);
      } catch (error) {
        await this.operations.failAttempt(operationRun.attemptId, error);
        throw error;
      }
    }
    const data = decision.data;
    try {
      const contentHash = hashStableJson(data as unknown as JsonValue);
      const targets = await this.repositories.targets.listEnabled();
      await this.unitOfWork.transaction(async (repositories) => {
        const internal = await repositories.internalProducts.upsert({ sourceProductId: product.id, data, inputHash, contentHash,
          processorVersion: processor.version, status: decision.status,
          processedAt: new Date().toISOString(), lastError: null });
        if (decision.legacyRun !== null) await repositories.classifications.saveProductResult({
          sourceId: source.id,
          sourceProductId: product.id,
          processorVersion: processor.classificationVersion,
          classifierVersion: this.classifier.version,
          fingerprint: decision.legacyRun.product.classification.fingerprint,
          observations: decision.legacyRun.observations,
        });
        if (attemptId !== null && operationsOutput !== null) {
          await repositories.productOperationHistory.completeAttempt(attemptId, operationsOutput, data, new Date().toISOString());
        }
        if ((decision.status === "classified" || decision.mode === "v2") && existing?.contentHash !== contentHash) {
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
    const sourceDto: SourceDTO = { id: source.id, code: source.code, config: source.config };
    const productDto: SourceProductDTO = { id: product.id, sourceId: source.id, sourceKey: product.sourceKey,
      ...(product.externalId === null ? {} : { externalId: product.externalId }),
      ...(product.slug === null ? {} : { slug: product.slug }),
      ...(product.url === null ? {} : { url: product.url }), metadata: product.discoveryMetadata };
    const decision = await this.decide(sourceDto, productDto, existing.data);
    const data = decision.data;
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
        status: decision.status,
        processedAt: existing.processedAt,
        lastError: null,
      });
      if (decision.legacyRun !== null) await repositories.classifications.saveProductResult({
        sourceId: source.id,
        sourceProductId: product.id,
        processorVersion: processor.classificationVersion,
        classifierVersion: this.classifier.version,
        fingerprint: decision.legacyRun.product.classification.fingerprint,
        observations: decision.legacyRun.observations,
      });
      if (decision.status === "classified" || decision.mode === "v2") {
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
