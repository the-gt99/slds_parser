import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { ProductOperationPipeline } from "../../src/application/index.js";
import type { ProductOperationContext, UniversalProductDTO } from "../../src/contracts/index.js";
import { IntegrationContractError } from "../../src/core/errors/index.js";
import { ProductOperationRegistry } from "../../src/core/registry/index.js";
import { LocalImageStore } from "../../src/infrastructure/media/index.js";
import type { ImageBinaryDownloader, TextTranslationProvider } from "../../src/processing/index.js";
import { ConvertImagesToWebpOperation, DownloadImagesOperation, NormalizeProductOperation, PublishImagesOperation, TranslateContentOperation, ValidateProcessedProductOperation } from "../../src/processing/index.js";
import { validProduct } from "../support/in-memory.js";

const context = {
  source: { id: "1", code: "goat", config: {} },
  sourceProduct: { id: "2", sourceId: "1", sourceKey: "product-1", metadata: {} },
} satisfies ProductOperationContext;

function product(overrides: Partial<UniversalProductDTO> = {}): UniversalProductDTO {
  return {
    ...validProduct(),
    attributes: { brand: "Example Brand", story: "Source story", color: "blue / white", details: "Leather", upperMaterial: "Mesh" },
    images: [{ url: "https://image.example/main.png", position: 0, alt: "Product", attributes: {} }],
    variants: [{ sourceVariantKey: "product|S", sku: "SKU-S", size: { sourceValue: "103", displayValue: "S" }, price: { amount: "123.45", currency: "USD" }, inventory: { availability: "available" }, conditionReferenceId: null, attributes: {} }],
    ...overrides,
  };
}

describe("product operations", () => {
  it("normalizes only confirmed DTO fields and GOAT image rules", async () => {
    const input = product({
      title: "  Product  ",
      description: " #REF! ",
      sku: " SKU ",
      attributes: { brand: " Example Brand ", model: " #VALUE! ", untouched: "  keep  " },
      images: [
        { url: " https://image.example/main.png ", position: 5, alt: " Product ", attributes: {} },
        { url: "https://image.example/main.png", position: 6, alt: "Duplicate", attributes: {} },
        { url: "https://image.example/placeholders/product_templates/missing.png", position: 7, alt: "Missing", attributes: {} },
      ],
      variants: [{ sourceVariantKey: " key ", sku: " SKU-S ", size: { sourceValue: " 103 ", displayValue: " S " }, price: { amount: " 123.45 ", currency: " usd " }, inventory: { availability: "available" }, conditionReferenceId: null, attributes: { shoeCondition: " new_no_defects " } }],
    });

    const result = await new NormalizeProductOperation().execute(input, context);

    expect(result).toMatchObject({ title: "Product", description: "", sku: "SKU", attributes: { brand: "Example Brand", model: "", untouched: "  keep  " } });
    expect(result.images).toEqual([{ url: "https://image.example/main.png", sourceUrl: "https://image.example/main.png", position: 0, alt: "Product", attributes: {} }]);
    expect(result.variants[0]).toMatchObject({ sourceVariantKey: "key", sku: "SKU-S", size: { sourceValue: "103", displayValue: "S" }, price: { amount: "123.45", currency: "USD" }, attributes: { shoeCondition: "new_no_defects" } });
    expect(input.title).toBe("  Product  ");
  });

  it("keeps source content and writes separately translated confirmed fields", async () => {
    const translate = vi.fn(async (text: string) => ({ "Description": "Описание", "Source story": "История", "Leather": "Кожа", "Mesh": "Сетка" })[text] ?? text);
    const provider: TextTranslationProvider = { code: "fake", version: "1", translate };
    const input = product({ description: "Description" });

    const result = await new TranslateContentOperation(provider, { sourceLocale: "en", targetLocale: "ru" }).execute(input);

    expect(result.description).toBe("Description");
    expect(result.translatedContent).toEqual({ sourceLocale: "en", targetLocale: "ru", description: "Описание", story: "История", color: "Синий/ Белый", details: "Кожа", upperMaterial: "Сетка" });
    expect(translate).not.toHaveBeenCalledWith("blue", "en", "ru");
    expect(translate).not.toHaveBeenCalledWith("white", "en", "ru");
  });

  it("rejects an unverified translation instead of silently preserving source text", async () => {
    const provider: TextTranslationProvider = { code: "fake", version: "1", translate: async (text) => text };
    await expect(new TranslateContentOperation(provider, { sourceLocale: "en", targetLocale: "ru" }).execute(product({ description: "Description" }))).rejects.toBeInstanceOf(IntegrationContractError);
  });

  it("downloads, validates, converts, publishes and validates real image bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slds-images-"));
    try {
      const binary = await sharp({ create: { width: 2, height: 3, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
      const downloader: ImageBinaryDownloader = { code: "fixture", version: "1", download: vi.fn().mockResolvedValue(binary) };
      const translator: TextTranslationProvider = {
        code: "fixture",
        version: "1",
        translate: vi.fn(async (text: string) => ({
          Description: "Описание",
          "Source story": "История",
          Leather: "Кожа",
          Mesh: "Сетка",
        })[text] ?? text),
      };
      const store = new LocalImageStore({ baseDirectory: directory, publicBaseUrl: "https://parser.example/images", webpQuality: 85 });
      const registry = new ProductOperationRegistry();
      registry.register(new NormalizeProductOperation());
      registry.register(new TranslateContentOperation(translator, { sourceLocale: "en", targetLocale: "ru", sourceCodes: ["goat"] }));
      registry.register(new DownloadImagesOperation(downloader, store, { concurrency: 2, sourceCodes: ["goat"] }));
      registry.register(new ConvertImagesToWebpOperation(store, { concurrency: 2, sourceCodes: ["goat"] }));
      registry.register(new PublishImagesOperation(store, ["goat"]));
      registry.register(new ValidateProcessedProductOperation(["goat"]));

      const pipeline = new ProductOperationPipeline(registry);
      const result = await pipeline.run(product(), context);

      expect(result.translatedContent).toMatchObject({ story: "История", color: "Синий/ Белый", details: "Кожа", upperMaterial: "Сетка" });
      expect(result.images[0]).toMatchObject({ sourceUrl: "https://image.example/main.png", localPath: "goat/item_2/01-main.png", webpLocalPath: "goat/item_2/01-main.webp", mimeType: "image/png", storedFormat: "png", width: 2, height: 3, url: "https://parser.example/images/goat/item_2/01-main.webp" });
      expect(existsSync(store.resolvePath(result.images[0]!.localPath!))).toBe(true);
      expect(existsSync(store.resolvePath(result.images[0]!.webpLocalPath!))).toBe(true);
      if (process.platform !== "win32") {
        expect((await stat(store.resolvePath(result.images[0]!.webpLocalPath!))).mode & 0o777).toBe(0o640);
        expect((await stat(join(directory, "goat", "item_2"))).mode & 0o777).toBe(0o750);
      }
      await expect(pipeline.run(product(), context)).resolves.toMatchObject({ images: [{ url: "https://parser.example/images/goat/item_2/01-main.webp" }] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the old finalization requirements without inventing extra required fields", async () => {
    const operation = new ValidateProcessedProductOperation();
    await expect(operation.execute(product({ attributes: { brand: "" } }))).rejects.toBeInstanceOf(IntegrationContractError);
    await expect(operation.execute(product({ images: [] }))).rejects.toBeInstanceOf(IntegrationContractError);
    await expect(operation.execute(product({ variants: [] }))).rejects.toBeInstanceOf(IntegrationContractError);
    await expect(operation.execute(product({ description: "" }))).resolves.toBeDefined();
  });
});
