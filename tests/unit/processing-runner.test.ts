import { describe, expect, it, vi } from "vitest";
import { ProcessingRunner } from "../../src/application/index.js";
import type { SourceProcessor } from "../../src/contracts/index.js";
import { SourceProcessorRegistry } from "../../src/core/registry/index.js";
import { ReferenceMappingService } from "../../src/services/index.js";
import { createMemoryRepositories, MemoryStore, MemoryUnitOfWork, seedProduct, sourceRecord, targetRecord, validProduct } from "../support/in-memory.js";

async function setup(version = "1") {
  const store = new MemoryStore(); store.sources.set("1", sourceRecord()); store.targets.set("10", targetRecord()); seedProduct(store);
  const repositories = createMemoryRepositories(store); await repositories.sourceProducts.upsertPart({ sourceProductId: "2", partKey: "details", rawPayload: {}, parsedPayload: { a: 1 }, contentHash: "part-hash", fetchedAt: "2026-01-01T00:00:00.000Z", adapterVersion: "1" });
  const process = vi.fn().mockResolvedValue(validProduct()); const processor: SourceProcessor = { sourceCode: "fake", version, process };
  const registry = new SourceProcessorRegistry(); registry.register(processor);
  return { store, repositories, process, runner: new ProcessingRunner(repositories, new MemoryUnitOfWork(store, repositories), registry, new ReferenceMappingService(repositories.references)) };
}

describe("ProcessingRunner", () => {
  it("selects processor, saves DTO and enqueues enabled targets", async () => {
    const { runner, store, process } = await setup(); await runner.processProduct({ sourceProductId: "2", force: false });
    expect(process).toHaveBeenCalledOnce(); expect([...store.internals.values()][0]?.data).toEqual(validProduct());
    expect([...store.jobs.values()][0]?.uniqueKey).toMatch(/internal-product:.*:target:10:export/);
  });
  it("skips unchanged input and version changes input hash", async () => {
    const first = await setup("1"); await first.runner.processProduct({ sourceProductId: "2", force: false }); const hash1 = [...first.store.internals.values()][0]!.inputHash;
    first.store.jobs.clear(); await first.runner.processProduct({ sourceProductId: "2", force: false }); expect(first.process).toHaveBeenCalledTimes(1);
    const secondProcess = vi.fn().mockResolvedValue(validProduct()); const registry = new SourceProcessorRegistry(); registry.register({ sourceCode: "fake", version: "2", process: secondProcess });
    const runner = new ProcessingRunner(first.repositories, new MemoryUnitOfWork(first.store, first.repositories), registry, new ReferenceMappingService(first.repositories.references));
    await runner.processProduct({ sourceProductId: "2", force: false }); expect([...first.store.internals.values()][0]!.inputHash).not.toBe(hash1); expect(secondProcess).toHaveBeenCalledOnce();
  });
  it("does not enqueue exports when content is unchanged", async () => {
    const { runner, store } = await setup(); await runner.processProduct({ sourceProductId: "2", force: false }); store.jobs.clear();
    await runner.processProduct({ sourceProductId: "2", force: true }); expect(store.jobs).toHaveLength(0);
  });
});
