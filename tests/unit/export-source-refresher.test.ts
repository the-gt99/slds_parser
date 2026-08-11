import { describe, expect, it, vi } from "vitest";

import { ExportSourceRefresher } from "../../src/application/index.js";
import type { ProductVariantDTO, SourceAdapter, SourceProcessor } from "../../src/contracts/index.js";
import { SourceAdapterRegistry, SourceProcessorRegistry } from "../../src/core/registry/index.js";
import { createMemoryRepositories, MemoryStore, MemoryUnitOfWork, seedProduct, sourceRecord } from "../support/in-memory.js";

describe("ExportSourceRefresher", () => {
  it("fetches only adapter-owned offers, persists them and extracts live variants without queueing jobs", async () => {
    const store = new MemoryStore();
    store.sources.set("1", sourceRecord());
    seedProduct(store);
    const repositories = createMemoryRepositories(store);
    await repositories.sourceProducts.upsertPart({
      sourceProductId: "2",
      partKey: "product",
      rawPayload: { id: "source-product" },
      parsedPayload: { id: "source-product" },
      contentHash: "product-hash",
      fetchedAt: "2026-08-11T10:00:00.000Z",
      adapterVersion: "1",
    });
    const collectProduct = vi.fn().mockResolvedValue({
      sourceKey: "product-1",
      parts: [{
        partKey: "offers",
        rawPayload: { offers: [{ price: 269300 }] },
        parsedPayload: { offers: [{ price: 269300 }] },
        adapterVersion: "1",
      }],
    });
    const adapters = new SourceAdapterRegistry();
    adapters.register({
      code: "fake-adapter",
      version: "1",
      exportRefreshPartKeys: ["offers"],
      discover: vi.fn(),
      collectProduct,
    } satisfies SourceAdapter);
    const liveVariants: readonly ProductVariantDTO[] = [{
      sourceVariantKey: "offer-8",
      sku: "SKU-8",
      size: { sourceValue: "8", displayValue: "8" },
      price: { amount: "2693.00", currency: "USD" },
      inventory: { availability: "available" },
      attributes: {},
    }];
    const processExportRefresh = vi.fn().mockImplementation(async (context) => {
      expect(context.parts.map((part: { partKey: string }) => part.partKey).sort()).toEqual(["offers", "product"]);
      return { variants: liveVariants };
    });
    const processors = new SourceProcessorRegistry();
    processors.register({
      sourceCode: "fake",
      version: "1",
      classificationVersion: "1",
      process: vi.fn(),
      processExportRefresh,
    } satisfies SourceProcessor);
    const refresher = new ExportSourceRefresher(
      repositories.sourceProducts,
      new MemoryUnitOfWork(store, repositories),
      adapters,
      processors,
      () => Date.parse("2026-08-11T12:00:00.000Z"),
    );

    await expect(refresher.refresh(store.sources.get("1")!, store.products.get("2")!)).resolves.toEqual(liveVariants);

    expect(collectProduct).toHaveBeenCalledWith(expect.objectContaining({ requestedPartKeys: ["offers"] }));
    expect(store.parts.get("2/offers")).toMatchObject({
      parsedPayload: { offers: [{ price: 269300 }] },
      fetchedAt: "2026-08-11T12:00:00.000Z",
    });
    expect(processExportRefresh).toHaveBeenCalledOnce();
    expect(store.jobs).toHaveLength(0);
  });
});
