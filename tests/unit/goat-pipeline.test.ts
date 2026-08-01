import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { CollectionRunner, ExportRunner, JobDispatcher, ProcessingRunner, ProductOperationPipeline, Worker } from "../../src/application/index.js";
import type { JsonValue } from "../../src/contracts/index.js";
import { ProductOperationRegistry, SourceAdapterRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "../../src/core/registry/index.js";
import { GoatSourceAdapter, GoatSourceProcessor } from "../../src/integrations/index.js";
import { ProductClassifier, TargetReferenceMappingService } from "../../src/services/index.js";
import { createMemoryRepositories, MemoryStore, MemoryUnitOfWork, sourceRecord } from "../support/in-memory.js";

const fixture = (name: string): Buffer => readFileSync(new URL(`../fixtures/goat/${name}`, import.meta.url));
const jsonFixture = (name: string): JsonValue => JSON.parse(fixture(name).toString("utf8")) as JsonValue;

describe("GOAT fixture pipeline", () => {
  it("runs sitemap, product, offers and processing through to internal_products", async () => {
    const index = Buffer.from(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://fixture/sitemap_apparel-test.xml.gz</loc></sitemap></sitemapindex>`);
    const adapter = new GoatSourceAdapter(async (url) => url.endsWith("sitemap") ? index : fixture("products.xml"), async (_url, expected) => expected === "product" ? jsonFixture("product.json") : jsonFixture("offers.json"));
    const store = new MemoryStore();
    store.sources.set("1", sourceRecord({ code: "goat", adapterCode: "goat", config: { sitemapUrl: "https://fixture/sitemap", countryCode: "US", discoveryBatchSize: 1, maxProductsPerRun: 1, requestDelayMs: 0 } }));
    const repositories = createMemoryRepositories(store);
    const unit = new MemoryUnitOfWork(store, repositories);
    const adapters = new SourceAdapterRegistry(); adapters.register(adapter);
    const processors = new SourceProcessorRegistry(); processors.register(new GoatSourceProcessor());
    const exporters = new TargetExporterRegistry();
    const classifier = new ProductClassifier(repositories.classifications);
    const targetMappings = new TargetReferenceMappingService(repositories.references);
    const dispatcher = new JobDispatcher(new CollectionRunner(repositories, unit, adapters), new ProcessingRunner(repositories, unit, processors, new ProductOperationPipeline(new ProductOperationRegistry()), classifier), new ExportRunner(repositories, exporters, targetMappings), repositories.sourceRuns);
    await repositories.jobs.enqueue({ jobType: "discover_source", payload: { sourceId: "1", runType: "smoke", coverage: "limited" }, uniqueKey: "goat-smoke" });
    const worker = new Worker(repositories.jobs, dispatcher, { workerId: "test", pollIntervalMs: 1, lockTimeoutMs: 100, maxJobAttempts: 3, retryBaseMs: 1, retryMaxMs: 10 });
    while (await worker.processNext()) {}
    expect(store.parts.size).toBe(2);
    expect(store.internals.size).toBe(1);
    const internal = [...store.internals.values()][0]?.data;
    expect(internal?.title).toBe("Test Shirt");
    expect(internal?.variants[0]).toMatchObject({ size: { sourceValue: "103" }, price: { amount: "123.45" } });
    expect([...store.jobs.values()].every((job) => job.status === "completed")).toBe(true);
  });
});
