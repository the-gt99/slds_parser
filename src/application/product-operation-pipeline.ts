import type {
  JsonValue,
  ProductOperationContext,
  UniversalProductDTO,
} from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { ProductOperationRegistry } from "../core/registry/index.js";

export class ProductOperationPipeline {
  constructor(private readonly operations: ProductOperationRegistry) {}

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

    for (const operation of this.operations.listForSource(context.source.code)) {
      const result = await operation.execute(product, context);

      if (result.sourceProductId !== context.sourceProduct.id) {
        throw new IntegrationContractError(
          `Product operation ${operation.code} changed sourceProductId`,
        );
      }

      product = result;
    }

    return product;
  }
}
