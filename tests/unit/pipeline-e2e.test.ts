import { describe, expect, it, vi } from "vitest";
import { CollectionRunner, ExportRunner, JobDispatcher, ProcessingRunner, ProductOperationPipeline, Worker } from "../../src/application/index.js";
import type { SourceAdapter, SourceProcessor, TargetExporter } from "../../src/contracts/index.js";
import { ProductOperationRegistry, SourceAdapterRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "../../src/core/registry/index.js";
import { ProductClassifier, TargetReferenceMappingService } from "../../src/services/index.js";
import { createMemoryRepositories, MemoryStore, MemoryUnitOfWork, sourceRecord, targetRecord, validProduct } from "../support/in-memory.js";

describe("pipeline end to end", () => {
  it("runs discovery, collection, processing and export through real worker and dispatcher", async () => {
    const store = new MemoryStore(); store.sources.set("1", sourceRecord()); store.targets.set("10", targetRecord()); const repositories = createMemoryRepositories(store); const unit = new MemoryUnitOfWork(store, repositories);
    const adapters = new SourceAdapterRegistry(); const adapter: SourceAdapter = { code: "fake-adapter", version: "1", discover: vi.fn().mockResolvedValue({ items: [{ sourceKey: "product-1", metadata: {} }], checkpoint: { done: true }, hasMore: false, completeness: "complete", stats: { processed: 1, discovered: 1 } }), collectProduct: vi.fn().mockImplementation(async ({ product }) => ({ sourceKey: product.sourceKey, parts: [{ partKey: "details", rawPayload: {}, parsedPayload: { title: "Product" }, adapterVersion: "1" }] })) }; adapters.register(adapter);
    const processors = new SourceProcessorRegistry(); const processor: SourceProcessor = { sourceCode: "fake", version: "1", classificationVersion: "1", process: vi.fn().mockImplementation(async ({ sourceProduct }) => validProduct(sourceProduct.id)) }; processors.register(processor);
    const exportCall = vi.fn().mockResolvedValue({ externalId: "external-1", operation: "created", metadata: {} }); const exporters = new TargetExporterRegistry(); const exporter: TargetExporter = { targetCode: "fake-exporter", version: "1", export: exportCall }; exporters.register(exporter);
    const classifier = new ProductClassifier(repositories.classifications); const targetMappings = new TargetReferenceMappingService(repositories.references); const collection = new CollectionRunner(repositories, unit, adapters); const processing = new ProcessingRunner(repositories, unit, processors, new ProductOperationPipeline(new ProductOperationRegistry()), classifier); const exports = new ExportRunner(repositories, exporters, targetMappings, adapters); const dispatcher = new JobDispatcher(collection, processing, exports, repositories.sourceRuns);
    await repositories.jobs.enqueue({ jobType: "discover_source", payload: { sourceId: "1", runType: "full", coverage: "catalog" }, uniqueKey: "discover:1" });
    const worker = new Worker(repositories.jobs, dispatcher, { workerId: "test", pollIntervalMs: 1, lockTimeoutMs: 100, maxJobAttempts: 3, retryBaseMs: 1, retryMaxMs: 10 });
    while (await worker.processNext()) {}
    expect(exportCall).toHaveBeenCalledOnce(); expect([...store.targetProducts.values()][0]).toMatchObject({ externalId: "external-1", status: "synced" }); expect([...store.jobs.values()].every((job) => job.status === "completed")).toBe(true);
  });
});
