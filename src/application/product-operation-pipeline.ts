import { randomUUID } from "node:crypto";

import type {
  JsonValue,
  ProductOperationContext,
  UniversalProductDTO,
} from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { ProductOperationRegistry } from "../core/registry/index.js";
import type { ProductOperationHistoryRepository } from "../repositories/index.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown product operation error";
}

export class ProductOperationPipeline {
  constructor(
    private readonly operations: ProductOperationRegistry,
    private readonly history?: ProductOperationHistoryRepository,
  ) {}

  fingerprint(sourceCode: string): JsonValue {
    return this.operations.listForSource(sourceCode).map((operation) => ({
      code: operation.code,
      version: operation.version,
      dependsOn: operation.dependsOn ?? [],
      configuration: operation.configurationFingerprint ?? null,
    }));
  }

  async run(
    initialProduct: UniversalProductDTO,
    context: ProductOperationContext,
  ): Promise<UniversalProductDTO> {
    return this.executeOperations(initialProduct, context, randomUUID());
  }

  async runTracked(
    initialProduct: UniversalProductDTO,
    context: ProductOperationContext,
    processorVersion: string,
  ): Promise<{ readonly product: UniversalProductDTO; readonly attemptId: string }> {
    const attemptId = randomUUID();
    await this.history?.startAttempt({
      attemptId,
      sourceProductId: context.sourceProduct.id,
      processorVersion,
      processorOutput: initialProduct,
      startedAt: new Date().toISOString(),
    });

    try {
      const product = await this.executeOperations(initialProduct, context, attemptId);
      return { product, attemptId };
    } catch (error) {
      if (this.history !== undefined) {
        try {
          await this.history.failAttempt(attemptId, errorMessage(error), new Date().toISOString());
        } catch (historyError) {
          throw new AggregateError([error, historyError], "Failed processing attempt and its history record");
        }
      }
      throw error;
    }
  }

  private async executeOperations(initialProduct: UniversalProductDTO, context: ProductOperationContext, attemptId: string): Promise<UniversalProductDTO> {
    let product = initialProduct;
    let sequence = 0;
    for (const operation of this.operations.listForSource(context.source.code)) {
      const startedAt = new Date().toISOString();
      const executionId = await this.history?.start({
        attemptId,
        sourceProductId: context.sourceProduct.id,
        operationCode: operation.code,
        operationName: operation.name ?? operation.code,
        operationVersion: operation.version,
        sequence,
        startedAt,
      });
      sequence += 1;

      try {
        const result = await operation.execute(product, context);

        if (result.sourceProductId !== context.sourceProduct.id) {
          throw new IntegrationContractError(
            `Product operation ${operation.code} changed sourceProductId`,
          );
        }

        product = result;
        if (executionId !== undefined) await this.history?.complete(executionId, product, new Date().toISOString());
      } catch (error) {
        if (executionId !== undefined) {
          try {
            await this.history?.fail(executionId, errorMessage(error), new Date().toISOString());
          } catch (historyError) {
            throw new AggregateError([error, historyError], `Failed operation ${operation.code} and its history record`);
          }
        }
        throw error;
      }
    }
    return product;
  }

  async completeAttempt(attemptId: string, operationsOutput: UniversalProductDTO, classifiedOutput: UniversalProductDTO): Promise<void> {
    await this.history?.completeAttempt(attemptId, operationsOutput, classifiedOutput, new Date().toISOString());
  }

  async failAttempt(attemptId: string, error: unknown): Promise<void> {
    await this.history?.failAttempt(attemptId, errorMessage(error), new Date().toISOString());
  }
}
