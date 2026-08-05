import { describe, expect, it, vi } from "vitest";

import { ProductOperationPipeline } from "../../src/application/index.js";
import type {
  ProductOperation,
  ProductOperationContext,
} from "../../src/contracts/index.js";
import {
  IntegrationContractError,
  ProductOperationDependencyError,
} from "../../src/core/errors/index.js";
import { ProductOperationRegistry } from "../../src/core/registry/index.js";
import type { ProductOperationHistoryRepository } from "../../src/repositories/index.js";
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
  it("records every completed operation in the product history", async () => {
    const registry = new ProductOperationRegistry();
    registry.register({ ...operation("normalize", "normalized"), name: "Нормализация" });
    registry.register({ ...operation("translate", "translated"), name: "Перевод" });
    const history = {
      startAttempt: vi.fn(), completeAttempt: vi.fn(), failAttempt: vi.fn(),
      start: vi.fn().mockResolvedValueOnce("11").mockResolvedValueOnce("12"),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn(),
    } satisfies ProductOperationHistoryRepository;

    await new ProductOperationPipeline(registry, history).run(validProduct(), context);

    expect(history.start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceProductId: "2", operationCode: "normalize", operationName: "Нормализация", sequence: 0,
    }));
    expect(history.start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceProductId: "2", operationCode: "translate", operationName: "Перевод", sequence: 1,
    }));
    expect(history.complete).toHaveBeenCalledTimes(2);
    expect(history.complete).toHaveBeenNthCalledWith(1, "11", expect.objectContaining({ title: "Product|normalized" }), expect.any(String));
    expect(history.fail).not.toHaveBeenCalled();
  });

  it("stores processor, operation and classified DTOs for a tracked attempt", async () => {
    const registry = new ProductOperationRegistry();
    registry.register(operation("normalize", "normalized"));
    const history = {
      startAttempt: vi.fn().mockResolvedValue(undefined), completeAttempt: vi.fn().mockResolvedValue(undefined), failAttempt: vi.fn(),
      start: vi.fn().mockResolvedValue("20"), complete: vi.fn().mockResolvedValue(undefined), fail: vi.fn(),
    } satisfies ProductOperationHistoryRepository;
    const pipeline = new ProductOperationPipeline(registry, history);

    const attempt = await pipeline.runTracked(validProduct(), context, "3.0.0");
    const classified = { ...attempt.product, classification: { status: "complete", classifierVersion: "1", fingerprint: "hash", resolved: [], ignored: [], unresolved: [] } } as const;
    await pipeline.completeAttempt(attempt.attemptId, attempt.product, classified);

    expect(history.startAttempt).toHaveBeenCalledWith(expect.objectContaining({ processorVersion: "3.0.0", processorOutput: expect.objectContaining({ title: "Product" }) }));
    expect(history.complete).toHaveBeenCalledWith("20", expect.objectContaining({ title: "Product|normalized" }), expect.any(String));
    expect(history.completeAttempt).toHaveBeenCalledWith(attempt.attemptId, attempt.product, classified, expect.any(String));
  });

  it("records the operation that failed and keeps its original error", async () => {
    const registry = new ProductOperationRegistry();
    const failure = new Error("translation failed");
    registry.register({ code: "translate", name: "Перевод", version: "1.0.0", execute: vi.fn().mockRejectedValue(failure) });
    const history = {
      startAttempt: vi.fn(), completeAttempt: vi.fn(), failAttempt: vi.fn(),
      start: vi.fn().mockResolvedValue("13"),
      complete: vi.fn(),
      fail: vi.fn().mockResolvedValue(undefined),
    } satisfies ProductOperationHistoryRepository;

    await expect(new ProductOperationPipeline(registry, history).run(validProduct(), context)).rejects.toBe(failure);

    expect(history.fail).toHaveBeenCalledWith("13", "translation failed", expect.any(String));
    expect(history.complete).not.toHaveBeenCalled();
  });

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
        dependsOn: [],
        configuration: { locale: "ru" },
      },
      {
        code: "goat-only",
        version: "1.0.0",
        dependsOn: [],
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

  it("rejects a missing or later operation dependency", () => {
    const registry = new ProductOperationRegistry();
    registry.register({
      ...operation("process-images", "processed"),
      dependsOn: ["download-images"],
    });
    registry.register(operation("download-images", "downloaded"));

    expect(() => registry.listForSource("goat")).toThrow(
      ProductOperationDependencyError,
    );
  });

  it("rejects a dependency that does not apply to the source", () => {
    const registry = new ProductOperationRegistry();
    registry.register(operation("download-images", "downloaded", ["other"]));
    registry.register({
      ...operation("process-images", "processed", ["goat"]),
      dependsOn: ["download-images"],
    });

    expect(() => registry.listForSource("goat")).toThrow(
      ProductOperationDependencyError,
    );
  });
});
