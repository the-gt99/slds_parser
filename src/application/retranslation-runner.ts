import { EntityNotFoundError, IntegrationContractError, RetryableError } from "../core/errors/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type { InternalProductRepository, SourceProductRepository, JobRepository } from "../repositories/index.js";
import type { TranslateContentOperation } from "../processing/index.js";
import type { RetranslateProductPayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

export interface RetranslationRunnerRepositories {
  readonly jobs?: JobRepository;
  readonly sourceProducts: SourceProductRepository;
  readonly internalProducts: InternalProductRepository;
}

export class RetranslationRunner {
  constructor(
    private readonly repositories: RetranslationRunnerRepositories,
    private readonly operation: TranslateContentOperation,
  ) {}

  async retranslateProduct(payload: RetranslateProductPayload): Promise<RunnerResult> {
    if (payload.reclassifyAfter === true && this.repositories.jobs === undefined) {
      throw new IntegrationContractError("Reclassification queue is not configured");
    }
    const sourceProduct = await this.repositories.sourceProducts.getById(payload.sourceProductId);
    if (sourceProduct === null) throw new EntityNotFoundError("Source product", payload.sourceProductId);
    const existing = await this.repositories.internalProducts.findBySourceProductId(sourceProduct.id);
    if (existing === null) throw new EntityNotFoundError("Internal product for source product", sourceProduct.id);
    if (this.operation.isCurrent(existing.data)) {
      await this.enqueueReclassification(payload);
      return { status: "skipped" };
    }

    const translated = await this.operation.execute(existing.data);
    if (translated.sourceProductId !== sourceProduct.id) {
      throw new IntegrationContractError(`Retranslated sourceProductId does not match ${sourceProduct.id}`);
    }
    const contentHash = hashStableJson(translated as never);
    const updated = await this.repositories.internalProducts.updateDataIfContentHash({
      id: existing.id,
      expectedContentHash: existing.contentHash,
      data: translated,
      contentHash,
    });
    if (updated === null) {
      throw new RetryableError("Internal product changed during retranslation", { code: "RETRANSLATION_CONFLICT" });
    }
    await this.enqueueReclassification(payload);
    return { status: "completed" };
  }

  private async enqueueReclassification(payload: RetranslateProductPayload): Promise<void> {
    if (payload.reclassifyAfter !== true) return;
    if (this.repositories.jobs === undefined) throw new IntegrationContractError("Reclassification queue is not configured");
    await this.repositories.jobs.enqueue({ jobType: "reclassify_product",payload: { sourceProductId: payload.sourceProductId },
      uniqueKey: `source-product:${payload.sourceProductId}:reclassify` });
  }
}
