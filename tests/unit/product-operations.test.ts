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
import type { ImageBinaryDownloader, ShoeHeightPredictionProvider, TextTranslationProvider } from "../../src/processing/index.js";
import { ConvertImagesToWebpOperation, DetectShoeHeightOperation, DownloadImagesOperation, NormalizeProductOperation, PublishImagesOperation, TranslateContentOperation, ValidateProcessedProductOperation } from "../../src/processing/index.js";
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
    variants: [{ sourceVariantKey: "product|S", sku: "SKU-S", size: { sourceValue: "103", displayValue: "S" }, price: { amount: "123.45", currency: "USD" }, inventory: { availability: "available" }, attributes: {} }],
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
      variants: [{ sourceVariantKey: " key ", sku: " SKU-S ", size: { sourceValue: " 103 ", displayValue: " S " }, price: { amount: " 123.45 ", currency: " usd " }, inventory: { availability: "available" }, attributes: { shoeCondition: " new_no_defects " } }],
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

  it("translates confirmed proprietary upper material names", async () => {
    const translate = vi.fn(async (text: string) => ({ Description: "Описание", "Source story": "История", Leather: "Кожа" })[text] ?? text);
    const provider: TextTranslationProvider = { code: "fake", version: "1", translate };

    await expect(new TranslateContentOperation(provider, { sourceLocale: "en", targetLocale: "ru" }).execute(product({ description: "Description", attributes: { brand: "Nike", story: "Source story", color: "blue", details: "Leather", upperMaterial: "Flymesh" } })))
      .resolves.toMatchObject({ translatedContent: { upperMaterial: "Флаймеш" } });
    await expect(new TranslateContentOperation(provider, { sourceLocale: "en", targetLocale: "ru" }).execute(product({ description: "Description", attributes: { brand: "Nike", story: "Source story", color: "blue", details: "Leather", upperMaterial: "Flyweave" } })))
      .resolves.toMatchObject({ translatedContent: { upperMaterial: "Флайвив" } });
    await expect(new TranslateContentOperation(provider, { sourceLocale: "en", targetLocale: "ru" }).execute(product({ description: "Description", attributes: { brand: "New Balance", story: "Source story", color: "blue", details: "Leather", upperMaterial: "NDure" } })))
      .resolves.toMatchObject({ translatedContent: { upperMaterial: "Эн-Дьюр" } });
    await expect(new TranslateContentOperation(provider, { sourceLocale: "en", targetLocale: "ru" }).execute(product({ description: "Description", attributes: { brand: "Under Armour", story: "Source story", color: "blue", details: "Leather", upperMaterial: "IntelliKnit" } })))
      .resolves.toMatchObject({ translatedContent: { upperMaterial: "ИнтеллиКнит" } });
    expect(translate).not.toHaveBeenCalledWith("Flymesh", "en", "ru");
    expect(translate).not.toHaveBeenCalledWith("Flyweave", "en", "ru");
    expect(translate).not.toHaveBeenCalledWith("NDure", "en", "ru");
    expect(translate).not.toHaveBeenCalledWith("IntelliKnit", "en", "ru");
  });

  it("uses the sneaker glossary for common material and colorway mistakes", async () => {
    const translate = vi.fn(async (text: string) => ({ Description: "Описание", "Source story": "История" })[text] ?? text);
    const provider: TextTranslationProvider = { code: "fake", version: "1", translate };
    const result = await new TranslateContentOperation(provider, { sourceLocale: "en", targetLocale: "ru" }).execute(product({
      description: "Description",
      attributes: { story: "Source story", color: "Navy", details: "Core Black/Racer Blue/Metallic Silver", upperMaterial: "Knit" },
    }));

    expect(result.translatedContent).toMatchObject({
      color: "Темно-синий",
      details: "Черный/ Синий/ Серебристый металлик",
      upperMaterial: "Трикотаж",
    });
    expect(translate).not.toHaveBeenCalledWith("Knit", "en", "ru");
    expect(translate).not.toHaveBeenCalledWith("Racer Blue", "en", "ru");
  });

  it("reuses one translation when GOAT description and story are identical", async () => {
    const translate = vi.fn(async (text: string) => ({ Story: "История", Leather: "Кожа", Mesh: "Сетка" })[text] ?? text);
    const provider: TextTranslationProvider = { code: "fake", version: "1", translate };
    const result = await new TranslateContentOperation(provider, { sourceLocale: "en", targetLocale: "ru" }).execute(product({
      description: "Story",
      attributes: { story: "Story", color: "blue", details: "Leather", upperMaterial: "Mesh" },
    }));

    expect(result.translatedContent).toMatchObject({ description: "История", story: "История" });
    expect(translate.mock.calls.filter(([value]) => value === "Story")).toHaveLength(1);
  });

  it("adds a shoe height candidate from the downloaded primary image", async () => {
    const prediction: ShoeHeightPredictionProvider = {
      code: "fixture-height",
      version: "1",
      configurationFingerprint: {},
      predict: vi.fn().mockResolvedValue({ predictedClass: "low", confidence: 0.99, top1Index: 1 }),
    };
    const store = { read: vi.fn().mockResolvedValue(Buffer.from("image")) };
    const input = product({ images: [{ url: "https://image.example/main.png", position: 0, alt: "Product", localPath: "goat/item_2/01-main.png", attributes: {} }] });

    const result = await new DetectShoeHeightOperation(prediction, store as never, { sourceImagePosition: 0 }).execute(input);

    expect(result.attributes).toMatchObject({ shoeHeight: "low" });
    expect(result.metadata).toMatchObject({ shoeHeightDetection: { predictedClass: "low", finalClass: "low", confidence: 0.99 } });
    expect(result.referenceCandidates).toContainEqual(expect.objectContaining({ key: "product:shoe-height", typeCode: "shoe_height", scope: "product.shoe_height", sourceValue: "low" }));
    expect(store.read).toHaveBeenCalledWith("goat/item_2/01-main.png");
  });

  it("uses an explicit title height over a conflicting visual prediction", async () => {
    const prediction: ShoeHeightPredictionProvider = {
      code: "fixture-height",
      version: "1",
      configurationFingerprint: {},
      predict: vi.fn().mockResolvedValue({ predictedClass: "high", confidence: 0.6 }),
    };
    const store = { read: vi.fn().mockResolvedValue(Buffer.from("image")) };
    const input = product({
      title: "Nike Dunk Low Black",
      images: [{ url: "https://image.example/main.png", position: 0, alt: "Product", localPath: "goat/item_2/01-main.png", attributes: {} }],
    });

    const result = await new DetectShoeHeightOperation(prediction, store as never, { sourceImagePosition: 0 }).execute(input);

    expect(result.attributes).toMatchObject({ shoeHeight: "low" });
    expect(result.metadata).toMatchObject({ shoeHeightDetection: { predictedClass: "high", finalClass: "low", titleHint: "low", modelOverrideApplied: true } });
  });

  it("skips products outside configured footwear categories", async () => {
    const prediction: ShoeHeightPredictionProvider = {
      code: "fixture-height",
      version: "1",
      configurationFingerprint: {},
      predict: vi.fn(),
    };
    const store = { read: vi.fn() };
    const input = product({ referenceCandidates: [{ key: "product:category", typeCode: "category", scope: "product.category", subjectKind: "product", sourceValue: "clothing", context: {}, evidence: {} }] });

    await expect(new DetectShoeHeightOperation(prediction, store as never, { sourceImagePosition: 0, eligibleCategoryValues: ["shoes"] }).execute(input)).resolves.toBe(input);
    expect(prediction.predict).not.toHaveBeenCalled();
  });

  it("accepts the normalized GOAT footwear category", async () => {
    const prediction: ShoeHeightPredictionProvider = {
      code: "fixture-height",
      version: "1",
      configurationFingerprint: {},
      predict: vi.fn().mockResolvedValue({ predictedClass: "low" }),
    };
    const store = { read: vi.fn().mockResolvedValue(Buffer.from("image")) };
    const input = product({ referenceCandidates: [{ key: "product:category", typeCode: "category", scope: "product.category", subjectKind: "product", sourceValue: "sneakers", context: {}, evidence: {} }], images: [{ url: "https://image.example/main.png", position: 0, alt: "Product", localPath: "goat/item_2/01-main.png", attributes: {} }] });

    const result = await new DetectShoeHeightOperation(prediction, store as never, { sourceImagePosition: 0, eligibleCategoryValues: ["sneakers"] }).execute(input);

    expect(result.attributes).toMatchObject({ shoeHeight: "low" });
    expect(prediction.predict).toHaveBeenCalledOnce();
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

  it("allows source products without media or offers while preserving identity requirements", async () => {
    const operation = new ValidateProcessedProductOperation();
    await expect(operation.execute(product({ attributes: { brand: "" } }))).rejects.toBeInstanceOf(IntegrationContractError);
    await expect(operation.execute(product({ images: [] }))).resolves.toBeDefined();
    await expect(operation.execute(product({ variants: [] }))).resolves.toBeDefined();
    await expect(operation.execute(product({ description: "" }))).resolves.toBeDefined();
  });

  it("passes an empty media set through media operations without external calls", async () => {
    const downloader: ImageBinaryDownloader = { code: "fixture", version: "1", download: vi.fn() };
    const store = {
      fingerprint: () => ({}),
      storeOriginal: vi.fn(),
      convertToWebp: vi.fn(),
      publicUrl: vi.fn(),
    };
    const input = product({ images: [] });

    await expect(new DownloadImagesOperation(downloader, store as never, { concurrency: 2 }).execute(input, context)).resolves.toBe(input);
    await expect(new ConvertImagesToWebpOperation(store as never, { concurrency: 2 }).execute(input)).resolves.toBe(input);
    expect(downloader.download).not.toHaveBeenCalled();
    expect(store.convertToWebp).not.toHaveBeenCalled();
  });
});
