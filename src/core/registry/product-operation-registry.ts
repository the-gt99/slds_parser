import type { ProductOperation } from "../../contracts/index.js";
import { DuplicateRegistrationError } from "../errors/index.js";

export class ProductOperationRegistry {
  readonly #operations = new Map<string, ProductOperation>();

  register(operation: ProductOperation): void {
    if (this.#operations.has(operation.code)) {
      throw new DuplicateRegistrationError("Product operation", operation.code);
    }

    this.#operations.set(operation.code, operation);
  }

  listForSource(sourceCode: string): readonly ProductOperation[] {
    return [...this.#operations.values()].filter(
      (operation) =>
        operation.sourceCodes === undefined ||
        operation.sourceCodes.includes(sourceCode),
    );
  }
}
