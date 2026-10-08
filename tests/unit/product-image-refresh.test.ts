import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductImageDTO, SourceAdapter } from "../../src/contracts/index.js";
import { ProductImageRefreshRunner } from "../../src/application/product-image-refresh-runner.js";
import { SourceAdapterRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "../../src/core/registry/index.js";
import { GoatSourceProcessor } from "../../src/integrations/goat/goat-source-processor.js";
import { LocalImageStore } from "../../src/infrastructure/media/local-image-store.js";
import { imageContentHash } from "../../src/processing/media/image-fingerprint.js";
import { createMemoryRepositories, MemoryStore, MemoryUnitOfWork, seedProduct, sourceRecord, targetRecord, validProduct } from "../support/in-memory.js";

const payload = { sourceProductId: "2", targetId: "3", externalId: "100" };
const url = "https://image.goat.com/test.png";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "slds-image-refresh-")); directories.push(root);
  const media = new LocalImageStore({ baseDirectory: root, publicBaseUrl: "https://media.example", webpQuality: 85 });
  const body = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
  const asset = await media.storeOriginal("goat", "2", 0, body);
  const oldPath = await media.convertToWebp(asset.localPath);
  const oldWebp = await media.read(oldPath);
  const image: ProductImageDTO = { url: media.publicUrl(oldPath), sourceUrl: url, position: 0,
    alt: "Product", attributes: {}, sourceContentHash: imageContentHash(body), contentHash: imageContentHash(oldWebp),
    webpLocalPath: oldPath, sourceEtag: '"old"' };
  const state = new MemoryStore(); seedProduct(state, { externalId: "100" });
  state.sources.set("1", sourceRecord({ code: "goat", adapterCode: "goat" }));
  state.targets.set("3", targetRecord({ id: "3", exporterCode: "wordpress" }));
  const repositories = createMemoryRepositories(state);
  await repositories.internalProducts.upsert({ sourceProductId: "2", data: { ...validProduct(), images: [image],
    attributes: { gender: "men" }, translatedContent: { sourceLocale: "en", targetLocale: "ru", description: "Перевод",
      story: "", color: "", details: "", upperMaterial: "" } }, inputHash: "input", contentHash: "content", processorVersion: "3", status: "classified" });
  const sourceImages = { urls: [url] };
  const collectProduct = vi.fn(async () => ({ sourceKey: "product-1", externalId: "100",
    parts: [{ partKey: "product", adapterVersion: "1", rawPayload: {}, parsedPayload: { name: "Product", images: sourceImages.urls } }] }));
  const adapters = new SourceAdapterRegistry();
  adapters.register({ code: "goat", version: "1", imageRefreshPartKeys: ["product"], collectProduct,
    discover: vi.fn() } as SourceAdapter);
  const processors = new SourceProcessorRegistry(); const processor = new GoatSourceProcessor(); processors.register(processor);
  const fullProcess = vi.spyOn(processor, "process");
  const client = { inspect: vi.fn(async () => ({ unchanged: true, etag: '"old"' })),
    downloadImage: vi.fn(async () => ({ body, etag: '"new"' })) };
  const checks = { enqueueDue: vi.fn(async () => true), recordCheck: vi.fn() };
  const exporters = new TargetExporterRegistry(); const exportImages = vi.fn(async () => ({ externalId: "100", operation: "updated" as const, metadata: {} }));
  const resumeExport = vi.fn(async () => ({ externalId: "100", operation: "updated" as const, metadata: {} }));
  exporters.register({ targetCode: "wordpress", version: "1", export: vi.fn(), exportImages, resumeExport });
  const runner = new ProductImageRefreshRunner(repositories, new MemoryUnitOfWork(state, repositories), adapters,
    processors, new Map([["goat", client]]), media, checks, exporters);
  return { runner, state, repositories, client, checks, fullProcess, sourceImages, media, oldPath, oldWebp, body, exportImages, resumeExport };
}

describe("product image refresh", () => {
  it("keeps 304 checks cheap and does not run processing or download media", async () => {
    const f = await setup();
    await expect(f.runner.check(payload)).resolves.toEqual({ status: "skipped" });
    expect(f.client.inspect).toHaveBeenCalledWith(url, { etag: '"old"' });
    expect(f.client.downloadImage).not.toHaveBeenCalled(); expect(f.fullProcess).not.toHaveBeenCalled();
    expect(f.state.jobs.size).toBe(0);
  });

  it("creates one deferred download job for a changed validator, then checks actual bytes", async () => {
    const f = await setup(); f.client.inspect.mockResolvedValue({ unchanged: false, etag: '"new"' });
    await f.runner.check(payload); await f.runner.check(payload);
    expect([...f.state.jobs.values()].map((job) => job.jobType)).toEqual(["refresh_product_images"]);
    expect(f.client.downloadImage).not.toHaveBeenCalled();
    await expect(f.runner.refresh(payload)).resolves.toEqual({ status: "skipped" });
    expect([...f.state.jobs.values()].map((job) => job.jobType)).toEqual(["refresh_product_images"]);
    expect((await f.repositories.internalProducts.findBySourceProductId("2"))?.data.images[0]?.sourceEtag).toBe('"new"');
  });

  it("replaces changed bytes at the same URL, preserves other DTO fields and queues only media export", async () => {
    const f = await setup();
    const before = (await f.repositories.internalProducts.findBySourceProductId("2"))!;
    const body = await sharp({ create: { width: 16, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
    f.client.downloadImage.mockResolvedValue({ body, etag: '"new"' });
    await f.runner.refresh(payload);
    const after = (await f.repositories.internalProducts.findBySourceProductId("2"))!;
    const { images: _beforeImages, ...beforeRest } = before.data;
    const { images: _afterImages, ...afterRest } = after.data;
    expect(afterRest).toEqual(beforeRest);
    expect(after).toMatchObject({ inputHash: before.inputHash, processorVersion: before.processorVersion, status: before.status });
    expect(after.data.images[0]?.url).not.toBe(before.data.images[0]?.url);
    expect(after.data.images[0]?.sourceContentHash).toBe(imageContentHash(body));
    expect(await f.media.read(f.oldPath)).toEqual(f.oldWebp);
    expect([...f.state.jobs.values()].map((job) => job.jobType)).toEqual(["export_product_images"]);
    await f.runner.exportImages(payload);
    expect(f.exportImages).toHaveBeenCalledOnce(); expect(f.state.targetProducts.size).toBe(0);
    expect(f.fullProcess).not.toHaveBeenCalled();
  });

  it("initializes old images without validators instead of trusting an unpaired ETag", async () => {
    const f = await setup(); const old = (await f.repositories.internalProducts.findBySourceProductId("2"))!;
    const { sourceEtag: _etag, ...image } = old.data.images[0]!;
    await f.repositories.internalProducts.updateDataIfContentHash({ id: old.id, expectedContentHash: old.contentHash,
      data: { ...old.data, images: [image] }, contentHash: "without-validator" });
    await f.runner.check(payload);
    expect(f.client.inspect).not.toHaveBeenCalled();
    expect([...f.state.jobs.values()][0]?.jobType).toBe("refresh_product_images");
  });

  it("detects gallery removal and order changes, but blocks an empty source list", async () => {
    const f = await setup(); const old = (await f.repositories.internalProducts.findBySourceProductId("2"))!;
    await f.repositories.internalProducts.updateDataIfContentHash({ id: old.id, expectedContentHash: old.contentHash,
      data: { ...old.data, images: [...old.data.images, { ...old.data.images[0]!, position: 1, sourceUrl: url + "?second" }] }, contentHash: "gallery" });
    await f.runner.check(payload); expect(f.client.inspect).not.toHaveBeenCalled();
    f.sourceImages.urls = [];
    await expect(f.runner.refresh(payload)).rejects.toThrow("no real images");
    expect((await f.repositories.internalProducts.findBySourceProductId("2"))?.data.images).toHaveLength(2);
  });

  it("leaves the DTO and export queue intact on image validation or concurrent update failure", async () => {
    const f = await setup(); f.client.downloadImage.mockResolvedValue({ body: Buffer.from("broken"), etag: '"new"' });
    await expect(f.runner.refresh(payload)).rejects.toThrow(); expect(f.state.jobs.size).toBe(0);
    expect((await f.repositories.internalProducts.findBySourceProductId("2"))?.contentHash).toBe("content");
    f.client.downloadImage.mockResolvedValue({ body: f.body, etag: '"new"' });
    vi.spyOn(f.repositories.internalProducts, "updateDataIfContentHash").mockResolvedValue(null);
    await expect(f.runner.refresh(payload)).rejects.toMatchObject({ code: "IMAGE_REFRESH_CONFLICT" });
    expect(f.state.jobs.size).toBe(0);
  });

  it("blocks a disabled target and resumes an accepted image export without resubmitting", async () => {
    const f = await setup(); const target = f.state.targets.get("3")!;
    f.state.targets.set("3", { ...target, enabled: false });
    await expect(f.runner.exportImages(payload)).rejects.toThrow("target is disabled");
    expect(f.exportImages).not.toHaveBeenCalled();
    f.state.targets.set("3", target);
    await f.runner.exportImages({ ...payload, submission: { receipt: { jobId: 9 }, exportedHash: "a".repeat(64), exportFingerprint: "b".repeat(64) } });
    expect(f.resumeExport).toHaveBeenCalledWith({ jobId: 9 }); expect(f.exportImages).not.toHaveBeenCalled();
  });

  it("allows explicitly enabled media writes while keeping general target exports disabled", async () => {
    const f = await setup(); const target = f.state.targets.get("3")!;
    f.state.targets.set("3", { ...target, enabled: false, config: { ...target.config, imageRefreshEnabled: "true" } });
    await expect(f.runner.exportImages(payload)).rejects.toThrow("target is disabled");
    f.state.targets.set("3", { ...target, enabled: false, config: { ...target.config, imageRefreshEnabled: true } });
    await f.runner.exportImages(payload);
    expect(f.exportImages).toHaveBeenCalledOnce();
    expect(f.state.targets.get("3")?.enabled).toBe(false);
  });
});
