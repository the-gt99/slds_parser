import { describe, expect, it, vi } from "vitest";

import { ProductOperationPipeline } from "../../src/application/index.js";
import type {
  ProductOperation,
  ProductOperationContext,
} from "../../src/contracts/index.js";
import { IntegrationContractError } from "../../src/core/errors/index.js";
import { ProductOperationRegistry } from "../../src/core/registry/index.js";
import { validProduct } from "../support/in-memory.js";

const context = {
  source: { id: "1", code: "goat", config: {} },
  sourceProduct: {
    id: "2",
    sourceId: "1",
    sourceKey: "product-1",
    metadata: {},
  },
} satisfies ProductOperationContext;

function operation(
  code: string,
  suffix: string,
  sourceCodes?: readonly string[],
): ProductOperation {
  return {
    code,
    version: "1.0.0",
    ...(sourceCodes === undefined ? {} : { sourceCodes }),
    execute: vi.fn(async (product) => ({
      ...product,
      title: `${product.title}|${suffix}`,
    })),
  };
}

describe("product operation pipeline", () => {
  it("runs universal and matching source operations in registration order", async () => {
    const universal = operation("universal", "universal");
    const goat = operation("goat-only", "goat", ["goat"]);
    const other = operation("other-only", "other", ["other"]);
    const registry = new ProductOperationRegistry();
    registry.register(universal);
    registry.register(goat);
    registry.register(other);
    const initial = validProduct();

    const result = await new ProductOperationPipeline(registry).run(
      initial,
      context,
    );

    expect(result.title).toBe("Product|universal|goat");
    expect(initial.title).toBe("Product");
    expect(universal.execute).toHaveBeenCalledOnce();
    expect(goat.execute).toHaveBeenCalledOnce();
    expect(other.execute).not.toHaveBeenCalled();
  });

  it("includes operation order, versions and configuration in its fingerprint", () => {
    const registry = new ProductOperationRegistry();
    registry.register({
      ...operation("normalize", "normalized"),
      version: "2.1.0",
      configurationFingerprint: { locale: "ru" },
    });
    registry.register(operation("goat-only", "goat", ["goat"]));
    registry.register(operation("other-only", "other", ["other"]));

    expect(new ProductOperationPipeline(registry).fingerprint("goat")).toEqual([
      {
        code: "normalize",
        version: "2.1.0",
        configuration: { locale: "ru" },
      },
      {
        code: "goat-only",
        version: "1.0.0",
        configuration: null,
      },
    ]);
  });

  it("rejects an operation that changes product identity", async () => {
    const registry = new ProductOperationRegistry();
    registry.register({
      code: "invalid-identity",
      version: "1.0.0",
      execute: async (product) => ({ ...product, sourceProductId: "other" }),
    });

    await expect(
      new ProductOperationPipeline(registry).run(validProduct(), context),
    ).rejects.toBeInstanceOf(IntegrationContractError);
  });
});
