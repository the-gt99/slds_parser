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
    let product = initialProduct;
    const attemptId = randomUUID();
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
        if (executionId !== undefined) await this.history?.complete(executionId, new Date().toISOString());
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
}
