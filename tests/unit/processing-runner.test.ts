import { describe, expect, it, vi } from "vitest";
import { ProcessingRunner, ProductOperationPipeline } from "../../src/application/index.js";
import type { ProductOperation, SourceProcessor } from "../../src/contracts/index.js";
import { ProductOperationRegistry, SourceProcessorRegistry } from "../../src/core/registry/index.js";
import type { ProductOperationHistoryRepository } from "../../src/repositories/index.js";
import { ProductClassifier } from "../../src/services/index.js";
import { createMemoryRepositories, MemoryStore, MemoryUnitOfWork, seedProduct, sourceRecord, targetRecord, validProduct } from "../support/in-memory.js";

async function setup(version = "1", operation?: ProductOperation, history?: ProductOperationHistoryRepository) {
  const store = new MemoryStore(); store.sources.set("1", sourceRecord()); store.targets.set("10", targetRecord()); seedProduct(store);
  const repositories = createMemoryRepositories(store); await repositories.sourceProducts.upsertPart({ sourceProductId: "2", partKey: "details", rawPayload: {}, parsedPayload: { a: 1 }, contentHash: "part-hash", fetchedAt: "2026-01-01T00:00:00.000Z", adapterVersion: "1" });
  const process = vi.fn().mockResolvedValue(validProduct()); const processor: SourceProcessor = { sourceCode: "fake", version, process };
  const registry = new SourceProcessorRegistry(); registry.register(processor);
  const operationRegistry = new ProductOperationRegistry(); if (operation) operationRegistry.register(operation);
  const transactionRepositories = history === undefined ? repositories : { ...repositories, productOperationHistory: history };
  return { store, repositories, process, runner: new ProcessingRunner(repositories, new MemoryUnitOfWork(store, transactionRepositories), registry, new ProductOperationPipeline(operationRegistry, history), new ProductClassifier(repositories.classifications)) };
}

describe("ProcessingRunner", () => {
  it("selects processor, saves DTO and enqueues enabled targets", async () => {
    const { runner, store, process } = await setup(); await runner.processProduct({ sourceProductId: "2", force: false });
    expect(process).toHaveBeenCalledOnce(); expect([...store.internals.values()][0]?.data).toMatchObject({ ...validProduct(), classification: { status: "complete", resolved: [], ignored: [], unresolved: [] } });
    expect([...store.internals.values()][0]?.status).toBe("classified");
    expect([...store.jobs.values()][0]?.uniqueKey).toMatch(/internal-product:.*:target:10:export/);
  });
  it("skips unchanged input and version changes input hash", async () => {
    const first = await setup("1"); await first.runner.processProduct({ sourceProductId: "2", force: false }); const hash1 = [...first.store.internals.values()][0]!.inputHash;
    first.store.jobs.clear(); await first.runner.processProduct({ sourceProductId: "2", force: false }); expect(first.process).toHaveBeenCalledTimes(1);
    const secondProcess = vi.fn().mockResolvedValue(validProduct()); const registry = new SourceProcessorRegistry(); registry.register({ sourceCode: "fake", version: "2", process: secondProcess });
    const runner = new ProcessingRunner(first.repositories, new MemoryUnitOfWork(first.store, first.repositories), registry, new ProductOperationPipeline(new ProductOperationRegistry()), new ProductClassifier(first.repositories.classifications));
    await runner.processProduct({ sourceProductId: "2", force: false }); expect([...first.store.internals.values()][0]!.inputHash).not.toBe(hash1); expect(secondProcess).toHaveBeenCalledOnce();
  });
  it("does not enqueue exports when content is unchanged", async () => {
    const { runner, store } = await setup(); await runner.processProduct({ sourceProductId: "2", force: false }); store.jobs.clear();
    await runner.processProduct({ sourceProductId: "2", force: true }); expect(store.jobs).toHaveLength(0);
  });
  it("saves operation output and includes the operation version in input hash", async () => {
    const operation = (version: string): ProductOperation => ({ code: "normalize", version, execute: async (product) => ({ ...product, title: "Normalized" }) });
    const first = await setup("1", operation("1")); await first.runner.processProduct({ sourceProductId: "2", force: false });
    const second = await setup("1", operation("2")); await second.runner.processProduct({ sourceProductId: "2", force: false });
    expect([...first.store.internals.values()][0]?.data.title).toBe("Normalized");
    expect([...first.store.internals.values()][0]?.inputHash).not.toBe([...second.store.internals.values()][0]?.inputHash);
  });
  it("reprocesses when source configuration changes", async () => {
    const { runner, store, process } = await setup(); await runner.processProduct({ sourceProductId: "2", force: false });
    const previous = store.sources.get("1")!; store.sources.set("1", { ...previous, config: { locale: "ru" } });
    await runner.processProduct({ sourceProductId: "2", force: false });
    expect(process).toHaveBeenCalledTimes(2);
  });
  it("reclassifies after a mapping change without rerunning source processing", async () => {
    const { runner, store, process } = await setup();
    process.mockResolvedValue({ ...validProduct(), referenceCandidates: [{ key: "product:brand", typeCode: "brand", scope: "product.brand", subjectKind: "product", sourceValue: "Nike", context: {}, evidence: { title: "Nike Product" } }] });
    await runner.processProduct({ sourceProductId: "2", force: false });
    expect([...store.internals.values()][0]?.status).toBe("classification_pending");
    expect(store.jobs.size).toBe(0);

    store.classificationDecisions.set("1/brand/product.brand/nike/{}", { mappingId: "20", referenceValueId: "30", status: "confirmed", revision: "1" });
    await runner.processProduct({ sourceProductId: "2", force: false });

    expect(process).toHaveBeenCalledOnce();
    expect([...store.internals.values()][0]?.status).toBe("classified");
    expect([...store.internals.values()][0]?.data.classification?.resolved[0]).toMatchObject({ referenceValueId: "30", resolutionKind: "mapping" });
    expect([...store.jobs.values()][0]?.jobType).toBe("export_product");
  });

  it("fails the processing attempt when saving the canonical result fails", async () => {
    const history = {
      startAttempt: vi.fn().mockResolvedValue(undefined),
      completeAttempt: vi.fn().mockResolvedValue(undefined),
      failAttempt: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue("execution-1"),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    } satisfies ProductOperationHistoryRepository;
    const { runner, repositories } = await setup("1", undefined, history);
    vi.spyOn(repositories.classifications, "saveProductResult").mockRejectedValueOnce(new Error("canonical save failed"));

    await expect(runner.processProduct({ sourceProductId: "2", force: false })).rejects.toThrow("canonical save failed");

    expect(history.startAttempt).toHaveBeenCalledOnce();
    expect(history.completeAttempt).not.toHaveBeenCalled();
    expect(history.failAttempt).toHaveBeenCalledWith(expect.any(String), "canonical save failed", expect.any(String));
  });
});
