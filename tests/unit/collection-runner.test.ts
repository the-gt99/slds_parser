import { describe, expect, it, vi } from "vitest";
import { CollectionRunner } from "../../src/application/index.js";
import type { SourceAdapter } from "../../src/contracts/index.js";
import { IntegrationContractError } from "../../src/core/errors/index.js";
import { SourceAdapterRegistry } from "../../src/core/registry/index.js";
import { createMemoryRepositories, MemoryStore, MemoryUnitOfWork, seedProduct, sourceRecord } from "../support/in-memory.js";

function setup(adapter: SourceAdapter) {
  const store = new MemoryStore(); store.sources.set("1", sourceRecord());
  const repositories = createMemoryRepositories(store); const registry = new SourceAdapterRegistry(); registry.register(adapter);
  return { store, repositories, runner: new CollectionRunner(repositories, new MemoryUnitOfWork(store, repositories), registry) };
}

describe("CollectionRunner", () => {
  it("selects adapter, paginates, deduplicates and saves checkpoint", async () => {
    const discover = vi.fn().mockResolvedValueOnce({ items: [{ sourceKey: "a", metadata: {} }, { sourceKey: "a", metadata: { newer: true } }], checkpoint: { page: 2 }, hasMore: true, completeness: "partial", stats: { processed: 2, discovered: 2 } }).mockResolvedValueOnce({ items: [{ sourceKey: "b", metadata: {} }], checkpoint: { page: 3 }, hasMore: false, completeness: "complete", stats: { processed: 1, discovered: 1 } });
    const adapter: SourceAdapter = { code: "fake-adapter", version: "1", discover, collectProduct: vi.fn() };
    const { runner, store } = setup(adapter); await runner.discoverSource({ sourceId: "1", runType: "full", coverage: "catalog" });
    expect(discover).toHaveBeenCalledTimes(2); expect(store.products).toHaveLength(2); expect([...store.runs.values()][0]?.checkpoint).toEqual({ page: 3 });
    expect([...store.jobs.values()].filter((job) => job.jobType === "collect_product")).toHaveLength(2);
  });

  it("continues an active run from its checkpoint", async () => {
    const adapter: SourceAdapter = { code: "fake-adapter", version: "1", discover: vi.fn().mockResolvedValue({ items: [], checkpoint: { page: 5 }, hasMore: false, completeness: "complete", stats: { processed: 0, discovered: 0 } }), collectProduct: vi.fn() };
    const { runner, repositories } = setup(adapter); await repositories.sourceRuns.create({ sourceId: "1", runType: "delta", coverage: "catalog", checkpoint: { page: 4 } });
    await runner.discoverSource({ sourceId: "1", runType: "full", coverage: "ignored" });
    expect(adapter.discover).toHaveBeenCalledWith(expect.objectContaining({ runType: "delta", checkpoint: { page: 4 } }));
  });

  it("saves discovery without enqueueing collection when explicitly disabled", async () => {
    const adapter: SourceAdapter = { code: "fake-adapter", version: "1", discover: vi.fn().mockResolvedValue({ items: [{ sourceKey: "a", metadata: {} }], checkpoint: { page: 1 }, hasMore: false, completeness: "complete", stats: { processed: 1, discovered: 1 } }), collectProduct: vi.fn() };
    const { runner, store } = setup(adapter);
    await runner.discoverSource({ sourceId: "1", runType: "full", coverage: "catalog", enqueueCollection: false });
    expect(store.products).toHaveLength(1);
    expect([...store.jobs.values()].filter((job) => job.jobType === "collect_product")).toHaveLength(0);
  });

  it("enqueues the full pipeline only for products first seen in an inventory discovery", async () => {
    const discover = vi.fn()
      .mockResolvedValueOnce({ items: [{ sourceKey: "a", metadata: { lastmod: "2026-09-01" } }], checkpoint: { page: 1 }, hasMore: false, completeness: "complete", stats: { processed: 1, discovered: 1 } })
      .mockResolvedValueOnce({ items: [{ sourceKey: "a", metadata: { lastmod: "2026-09-02" } }, { sourceKey: "b", metadata: {} }], checkpoint: { page: 1 }, hasMore: false, completeness: "complete", stats: { processed: 2, discovered: 2 } });
    const adapter: SourceAdapter = { code: "fake-adapter", version: "1", discover, collectProduct: vi.fn() };
    const { runner, store } = setup(adapter);
    await runner.discoverSource({ sourceId: "1", runType: "full", coverage: "catalog", enqueueCollection: false });
    store.jobs.clear();
    await runner.discoverSource({ sourceId: "1", runType: "inventory_refresh", coverage: "full", enqueueCollection: false, enqueueNewCollection: true });
    const jobs = [...store.jobs.values()].filter((job) => job.jobType === "collect_product");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ sourceProductId: [...store.products.values()].find((item) => item.sourceKey === "b")?.id });
  });

  it("enqueues hash-checked processing after every successful collection", async () => {
    const collectProduct = vi.fn().mockResolvedValue({ sourceKey: "product-1", parts: [{ partKey: "custom", rawPayload: {}, parsedPayload: { value: 1 }, adapterVersion: "1" }] });
    const adapter: SourceAdapter = { code: "fake-adapter", version: "1", discover: vi.fn(), collectProduct };
    const { runner, store } = setup(adapter); seedProduct(store);
    await runner.collectProduct({ sourceProductId: "2" });
    store.jobs.clear(); await runner.collectProduct({ sourceProductId: "2" });
    expect(store.parts.get("2/custom")?.parsedPayload).toEqual({ value: 1 });
    expect([...store.jobs.values()].map((job) => job.jobType)).toEqual(["process_product"]);
  });

  it("saves collected parts without enqueueing processing when explicitly disabled", async () => {
    const collectProduct = vi.fn().mockResolvedValue({ sourceKey: "product-1", parts: [{ partKey: "custom", rawPayload: {}, parsedPayload: { value: 1 }, adapterVersion: "1" }] });
    const adapter: SourceAdapter = { code: "fake-adapter", version: "1", discover: vi.fn(), collectProduct };
    const { runner, store } = setup(adapter); seedProduct(store);

    await runner.collectProduct({ sourceProductId: "2", enqueueProcessing: false });

    expect(store.parts.get("2/custom")?.parsedPayload).toEqual({ value: 1 });
    expect(store.jobs).toHaveLength(0);
  });

  it("rejects missing requested parts without overwriting old parts", async () => {
    const adapter: SourceAdapter = { code: "fake-adapter", version: "1", discover: vi.fn(), collectProduct: vi.fn().mockResolvedValue({ sourceKey: "product-1", parts: [] }) };
    const { runner, store } = setup(adapter); seedProduct(store);
    await expect(runner.collectProduct({ sourceProductId: "2", requestedPartKeys: ["details"] })).rejects.toBeInstanceOf(IntegrationContractError);
    expect(store.parts).toHaveLength(0);
  });

  it("rejects a non-advancing checkpoint", async () => {
    const adapter: SourceAdapter = { code: "fake-adapter", version: "1", discover: vi.fn().mockResolvedValue({ items: [], checkpoint: {}, hasMore: true, completeness: "partial", stats: { processed: 0, discovered: 0 } }), collectProduct: vi.fn() };
    const { runner } = setup(adapter);
    await expect(runner.discoverSource({ sourceId: "1", runType: "full", coverage: "catalog" })).rejects.toBeInstanceOf(IntegrationContractError);
  });
});
