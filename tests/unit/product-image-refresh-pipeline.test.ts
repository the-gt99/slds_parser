import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import type { JsonObject } from "../../src/contracts/index.js";
import { JobDispatcher, Worker } from "../../src/application/index.js";
import type { ProductImageJobPayload } from "../../src/application/job-payloads.js";
import { ProductImageRefreshRunner } from "../../src/application/product-image-refresh-runner.js";
import { WordPressVariationPatchRunner } from "../../src/application/wordpress-variation-patch-runner.js";
import { SourceAdapterRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "../../src/core/registry/index.js";
import { GoatSourceAdapter } from "../../src/integrations/goat/goat-source-adapter.js";
import { GoatSourceProcessor } from "../../src/integrations/goat/goat-source-processor.js";
import { WordPressExporter } from "../../src/integrations/wordpress/wordpress-exporter.js";
import { LocalImageStore } from "../../src/infrastructure/media/local-image-store.js";
import { createMemoryRepositories, MemoryStore, MemoryUnitOfWork, seedProduct, sourceRecord, targetRecord, validProduct } from "../support/in-memory.js";

it("runs inventory -> conditional check -> image refresh -> guarded WordPress media export through distinct jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "slds-media-pipeline-"));
  try {
    const state = new MemoryStore(); seedProduct(state, { externalId: "200" });
    state.sources.set("1", sourceRecord({ code: "goat", adapterCode: "goat", config: {
      sitemapUrl: "https://www.goat.com/sitemap.xml", countryCode: "US", discoveryBatchSize: 10, requestDelayMs: 0 } }));
    state.targets.set("3", targetRecord({ id: "3", code: "slamdunk", exporterCode: "wordpress" }));
    const repositories = createMemoryRepositories(state);
    const sourceUrl = "https://image.goat.com/same-address.png";
    await repositories.internalProducts.upsert({ sourceProductId: "2", data: { ...validProduct(),
      images: [{ url: "https://media.example/old.webp", sourceUrl, position: 0, alt: "Old", attributes: {},
        sourceContentHash: "a".repeat(64), contentHash: "b".repeat(64), sourceEtag: '"v1"' }] },
      inputHash: "old", contentHash: "old", processorVersion: "3", status: "classified" });
    const adapters = new SourceAdapterRegistry();
    const jsonRequest = vi.fn(async (_url: string, expected: "product" | "offers") => {
      if (expected !== "product") throw new Error("Media jobs must not collect offers");
      return { id: 200, name: "Product", pictureUrl: sourceUrl };
    });
    adapters.register(new GoatSourceAdapter(vi.fn(), jsonRequest));
    const processors = new SourceProcessorRegistry(); processors.register(new GoatSourceProcessor());
    const exporters = new TargetExporterRegistry();
    const snapshot = { product: { target_id: 100, type: "variable", status: "publish", title: "Название магазина",
      sku: "SKU", slug: "shop-slug", description_html: "Ручное описание", images: [], taxonomies: {}, variations: [] } };
    let written: { payload: JsonObject; patch: JsonObject } | undefined;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const action = new URL(String(input)).searchParams.get("slds_target_import_api");
      const body = JSON.parse(String(init?.body));
      const data = action === "product-snapshots" ? { ok: true, items: [{ source_external_id: "200", target_id: 100,
        found: true, matched_by: "source_identity", snapshot }] }
        : action === "upsert-lookup" ? { ok: true, target_id: 100, matched_by: "source_identity", variation_plan: [],
          snapshot, payload_hash: body.payload.payload_hash, image_identity_mode: "exact_content" }
        : action === "upsert-jobs" ? { ok: true, job: { job_id: 9, payload_hash: body.payload.payload_hash,
          status: "done", result: { target_id: 100, operation: "updated", matched_by: "source_identity" } } } : null;
      if (data === null) throw new Error(`Unexpected request ${action}`);
      if (action === "upsert-jobs") written = body;
      return new Response(JSON.stringify(data), { status: 200 });
    });
    exporters.register(new WordPressExporter({ baseUrl: "https://shop.example", authToken: "test", timeoutMs: 1000,
      jobTimeoutMs: 1000, pollIntervalMs: 100 }, request));
    const body = await sharp({ create: { width: 16, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
    const client = { inspect: vi.fn(async () => ({ unchanged: false, etag: '"v2"' })),
      downloadImage: vi.fn(async () => ({ body, etag: '"v2"' })) };
    const checks = { enqueueDue: vi.fn(async (payload: ProductImageJobPayload) => {
      await repositories.jobs.enqueue({ jobType: "check_product_images", payload: { ...payload }, uniqueKey: "image-check" }); return true;
    }), recordCheck: vi.fn() };
    const runner = new ProductImageRefreshRunner(repositories, new MemoryUnitOfWork(state, repositories), adapters, processors,
      new Map([["goat", client]]), new LocalImageStore({ baseDirectory: root, publicBaseUrl: "https://media.example", webpQuality: 85 }), checks, exporters);
    const inventory = Object.assign(Object.create(WordPressVariationPatchRunner.prototype), { repositories,
      repository: { listVariationCandidates: async () => [{ item: { id: "7", wordpressProductId: "100" },
        target: { id: "3" }, sourceProduct: { id: "2" } }], saveInventoryDonorState: vi.fn() },
      sources: repositories.sources, sourceProducts: repositories.sourceProducts, sourceRefresher: { refresh: async () => [] },
      currentTime: () => 0, imageRefreshes: runner, logError: vi.fn() }) as WordPressVariationPatchRunner;
    await inventory.collectGoat({ runId: "4", itemId: "7", wordpressProductId: "100" });
    expect(client.inspect).not.toHaveBeenCalled(); expect(client.downloadImage).not.toHaveBeenCalled();
    const dispatcher = Object.assign(Object.create(JobDispatcher.prototype), { imageRefreshes: runner, jobs: repositories.jobs }) as JobDispatcher;
    const worker = new Worker(repositories.jobs, dispatcher, { workerId: "test", pollIntervalMs: 1, lockTimeoutMs: 1000,
      maxJobAttempts: 3, retryBaseMs: 1, retryMaxMs: 10 });
    await worker.processNext(["check_product_images"]);
    expect([...state.jobs.values()][0]?.lastError).toBeNull();
    expect(client.inspect).toHaveBeenCalledOnce(); expect(client.downloadImage).not.toHaveBeenCalled();
    await worker.processNext(["refresh_product_images"]);
    expect(client.downloadImage).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
    await worker.processNext(["export_product_images"]);
    expect([...state.jobs.values()].map((job) => [job.jobType, job.status])).toEqual([
      ["check_product_images","completed"],["refresh_product_images","completed"],["export_product_images","completed"]]);
    expect(written?.payload.managed_fields).toEqual(["title", "images"]);
    expect(written?.patch.expected_target_snapshot).toEqual(snapshot);
    expect((written?.payload.product as JsonObject).title).toBe("Название магазина");
    expect(state.targetProducts.size).toBe(0);
    expect([...state.jobs.values()].at(-1)?.payload).toHaveProperty("submission.receipt.jobId", 9);
  } finally { await rm(root, { recursive: true, force: true }); }
});
