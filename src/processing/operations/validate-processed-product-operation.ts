import type { ProductOperation, UniversalProductDTO } from "../../contracts/index.js";
import { IntegrationContractError } from "../../core/errors/index.js";

export class ValidateProcessedProductOperation implements ProductOperation {
  readonly code = "validate-processed-product";
  readonly name = "Финальная проверка товара";
  readonly version = "1.2.0";
  readonly dependsOn = ["normalize-product", "publish-images"];
  readonly sourceCodes?: readonly string[];

  constructor(sourceCodes?: readonly string[]) {
    if (sourceCodes !== undefined) this.sourceCodes = sourceCodes;
  }

  async execute(product: UniversalProductDTO): Promise<UniversalProductDTO> {
    const brand = product.attributes.brand;
    if (product.title === "" || product.sku === "" || typeof brand !== "string" || brand === "") {
      throw new IntegrationContractError("Normalized product title, SKU and source brand are required");
    }
    return product;
  }
}
