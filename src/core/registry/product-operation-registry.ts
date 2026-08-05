import type { ProductOperation } from "../../contracts/index.js";
import {
  DuplicateRegistrationError,
  ProductOperationDependencyError,
} from "../errors/index.js";

export class ProductOperationRegistry {
  readonly #operations = new Map<string, ProductOperation>();

  register(operation: ProductOperation): void {
    if (this.#operations.has(operation.code)) {
      throw new DuplicateRegistrationError("Product operation", operation.code);
    }

    this.#operations.set(operation.code, operation);
  }

  list(): readonly ProductOperation[] {
    return [...this.#operations.values()];
  }

  listForSource(sourceCode: string): readonly ProductOperation[] {
    const applicable = [...this.#operations.values()].filter(
      (operation) =>
        operation.sourceCodes === undefined ||
        operation.sourceCodes.includes(sourceCode),
    );
    const earlier = new Set<string>();

    for (const operation of applicable) {
      for (const dependency of operation.dependsOn ?? []) {
        if (!earlier.has(dependency)) {
          throw new ProductOperationDependencyError(operation.code, dependency);
        }
      }
      earlier.add(operation.code);
    }

    return applicable;
  }
}
