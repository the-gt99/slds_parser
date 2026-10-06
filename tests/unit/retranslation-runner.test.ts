import { describe, expect, it, vi } from "vitest";

import { RetranslationRunner } from "../../src/application/index.js";
import { TranslateContentOperation } from "../../src/processing/index.js";
import { createMemoryRepositories, MemoryStore, seedProduct, validProduct } from "../support/in-memory.js";

describe("RetranslationRunner", () => {
  it("enqueues requested reclassification after translation and on safe replay", async () => {
    const store = new MemoryStore(); seedProduct(store);
    const repositories = createMemoryRepositories(store);
    await repositories.internalProducts.upsert({ sourceProductId: "2",data: validProduct(),inputHash: "in",contentHash: "old",processorVersion: "1",status: "classified" });
    const operation = new TranslateContentOperation({ code: "test",version: "1",translate: vi.fn(async () => "Описание") },{ sourceLocale: "en",targetLocale: "ru" });
    const enqueue = vi.spyOn(repositories.jobs,"enqueue");
    const runner = new RetranslationRunner(repositories,operation);
    expect(await runner.retranslateProduct({ sourceProductId: "2",reclassifyAfter: true })).toEqual({ status: "completed" });
    expect(await runner.retranslateProduct({ sourceProductId: "2",reclassifyAfter: true })).toEqual({ status: "skipped" });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith({ jobType: "reclassify_product",payload: { sourceProductId: "2" },uniqueKey: "source-product:2:reclassify" });
  });
  it("changes only translated content and does not enqueue downstream jobs", async () => {
    const store = new MemoryStore();
    seedProduct(store);
    const repositories = createMemoryRepositories(store);
    const initial = {
      ...validProduct(),
      translatedContent: { sourceLocale: "en", targetLocale: "ru", description: "Старый перевод", story: "", color: "", details: "", upperMaterial: "" },
    };
    await repositories.internalProducts.upsert({ sourceProductId: "2", data: initial, inputHash: "old-input", contentHash: "old-content", processorVersion: "processor-1", status: "classified" });
    const translate = vi.fn(async () => "Новый перевод");
    const operation = new TranslateContentOperation({ code: "deepl", version: "1", translate }, { sourceLocale: "en", targetLocale: "ru" });
    const runner = new RetranslationRunner(repositories, operation);

    await expect(runner.retranslateProduct({ sourceProductId: "2" })).resolves.toEqual({ status: "completed" });
    const updated = await repositories.internalProducts.findBySourceProductId("2");
    expect(updated).toMatchObject({ inputHash: "old-input", processorVersion: "processor-1", status: "classified" });
    expect(updated?.data).toMatchObject({
      title: "Product",
      referenceCandidates: [],
      translatedContent: { providerCode: "deepl", providerVersion: "1", description: "Новый перевод" },
    });
    expect(store.jobs).toHaveLength(0);

    await expect(runner.retranslateProduct({ sourceProductId: "2" })).resolves.toEqual({ status: "skipped" });
    expect(translate).toHaveBeenCalledOnce();
  });
});
