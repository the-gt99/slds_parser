import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { JsonObject, JsonValue, ProcessingContext, SourceDTO } from "../../src/contracts/index.js";
import { IntegrationContractError, PermanentError, RetryableError } from "../../src/core/errors/index.js";
import { GoatSourceAdapter, GoatSourceProcessor, assertGoatHttpStatus, isGoatHtmlChallenge, maskProxyCredentials, parseProductSitemap, parseSitemapIndex } from "../../src/integrations/index.js";

const fixture = (name: string): Buffer => readFileSync(new URL(`../fixtures/goat/${name}`, import.meta.url));
const jsonFixture = (name: string): JsonValue => JSON.parse(fixture(name).toString("utf8")) as JsonValue;
const source = (maxProductsPerRun?: number): SourceDTO => ({ id: "1", code: "goat", config: { sitemapUrl: "https://fixture/index.xml", countryCode: "US", discoveryBatchSize: 1, requestDelayMs: 0, ...(maxProductsPerRun ? { maxProductsPerRun } : {}) } });

describe("GOAT sitemap", () => {
  it("parses the product sitemap index only", () => { expect(parseSitemapIndex(fixture("sitemap-index.xml"))).toEqual(["https://static.example/sitemap_sneakers-nike.xml.gz", "https://static.example/sitemap_apparel-brand.xml.gz"]); });
  it("extracts route, slug, lastmod, title and images through XML namespaces", () => { const products = parseProductSitemap(fixture("products.xml")); expect(products).toHaveLength(2); expect(products[0]).toMatchObject({ slug: "test-shoe-red", route: "sneakers", lastmod: "2026-07-31T12:00:00Z", title: "Test Shoe Red", images: ["https://image.example/main.jpg", "https://image.example/side.jpg"] }); expect(products[1]).toMatchObject({ slug: "test-shirt", route: "apparel" }); });
  it("paginates with a checkpoint, caches the child and stops at the smoke limit", async () => {
    const index = Buffer.from(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://fixture/sitemap_sneakers-test.xml.gz</loc></sitemap></sitemapindex>`);
    const request = vi.fn(async (url: string) => url.endsWith("index.xml") ? index : fixture("products.xml"));
    const adapter = new GoatSourceAdapter(request);
    const first = await adapter.discover({ source: source(2), runType: "smoke", checkpoint: {} });
    const second = await adapter.discover({ source: source(2), runType: "smoke", checkpoint: first.checkpoint });
    expect(first).toMatchObject({ hasMore: true, completeness: "unknown", checkpoint: { childIndex: 0, itemIndex: 1, emitted: 1 } });
    expect(second).toMatchObject({ hasMore: false, completeness: "partial", checkpoint: { emitted: 2 } });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("GOAT adapter and processor", () => {
  it("uses the card and offers URLs and returns every requested part", async () => {
    const calls: string[] = [];
    const adapter = new GoatSourceAdapter(async () => Buffer.alloc(0), async (url, expected) => { calls.push(url); return expected === "product" ? jsonFixture("product.json") : jsonFixture("offers-empty.json"); });
    const collected = await adapter.collectProduct({ source: source(), product: { sourceKey: "test-shirt", slug: "test-shirt", metadata: {} }, requestedPartKeys: ["offers", "product"] });
    expect(calls[0]).toBe("https://www.goat.com/web-api/v1/product_templates/test-shirt?countryCode=US");
    expect(calls[1]).toBe("https://www.goat.com/web-api/v1/product_variants/buy_bar_data?productTemplateId=product-100&countryCode=US");
    expect(collected.externalId).toBe("product-100");
    expect(collected.parts.map((part) => part.partKey)).toEqual(["offers", "product"]);
    expect((collected.parts[0]?.parsedPayload as JsonObject).offers).toEqual([]);
  });
  it("extracts the exact image fields used by the old GOAT parser", async () => {
    const productPayload = {
      ...(jsonFixture("product.json") as JsonObject),
      pictureUrl: "https://image.example/main.jpg",
      productTemplateExternalPictures: [
        { mainPictureUrl: "https://image.example/main-duplicate.jpg" },
        { mainPictureUrl: "https://image.example/side.jpg" },
      ],
      images: ["https://image.example/not-used.jpg"],
    } satisfies JsonObject;
    const adapter = new GoatSourceAdapter(async () => Buffer.alloc(0), async (_url, expected) => expected === "product" ? productPayload : jsonFixture("offers-empty.json"));

    const collected = await adapter.collectProduct({ source: source(), product: { sourceKey: "test-shirt", slug: "test-shirt", metadata: {} }, requestedPartKeys: ["product"] });

    expect((collected.parts[0]?.parsedPayload as JsonObject).images).toEqual([
      "https://image.example/main.jpg",
      "https://image.example/side.jpg",
    ]);
  });
  it("rejects an unknown requested part", async () => { const adapter = new GoatSourceAdapter(async () => Buffer.alloc(0)); await expect(adapter.collectProduct({ source: source(), product: { sourceKey: "x", metadata: {} }, requestedPartKeys: ["unknown"] })).rejects.toBeInstanceOf(PermanentError); });
  it("keeps nullable prices, clothing size strings, conditions and additional prices", async () => {
    const processor = new GoatSourceProcessor();
    const context = { source: source(), sourceProduct: { id: "2", sourceId: "1", sourceKey: "test-shirt", metadata: {} }, parts: [
      { partKey: "product", rawPayload: jsonFixture("product.json"), parsedPayload: jsonFixture("product.json"), adapterVersion: "1.0.0" },
      { partKey: "offers", rawPayload: jsonFixture("offers.json"), parsedPayload: { market: "US", countryCode: "US", offers: jsonFixture("offers.json") }, adapterVersion: "1.0.0" },
    ] } satisfies ProcessingContext;
    const product = await processor.process(context);
    expect(product.variants[0]).toMatchObject({ sourceVariantKey: "product-100|US|103|new_no_defects|good_condition", size: { sourceValue: "103", displayValue: "S" }, price: { amount: "123.45", currency: "USD" }, inventory: { availability: "available" }, attributes: { shoeCondition: "new_no_defects", boxCondition: "good_condition", stockStatus: "single_in_stock", instantShipPrice: { amount: "130.00" }, lastSoldPrice: { amount: "120.01" } } });
    expect(product.variants[1]).toMatchObject({ price: null, inventory: { availability: "unavailable" } });
    expect(product.referenceCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "product:brand", typeCode: "brand", sourceValue: "Example Brand" }),
      expect.objectContaining({ key: "product:category", typeCode: "category", sourceValue: "apparel" }),
      expect.objectContaining({ key: "product:color", typeCode: "color", sourceValue: "blue" }),
    ]));
    expect(product.referenceCandidates.map((candidate) => candidate.typeCode)).not.toEqual(
      expect.arrayContaining(["size", "size_system", "condition", "box_condition", "activity"]),
    );
    expect(product.referenceCandidates.some((candidate) => candidate.scope === "product.tag.activity")).toBe(false);
    const offerRows = jsonFixture("offers.json") as readonly JsonValue[];
    const duplicate = { ...context, parts: [context.parts[0]!, { ...context.parts[1]!, parsedPayload: { market: "US", countryCode: "US", offers: [offerRows[0]!, offerRows[0]!] } }] } satisfies ProcessingContext;
    await expect(processor.process(duplicate)).rejects.toBeInstanceOf(IntegrationContractError);
  });
  it("maps only product fields confirmed by the old GOAT processor", async () => {
    const processor = new GoatSourceProcessor();
    const productPayload = {
      ...(jsonFixture("product.json") as JsonObject),
      story: "Source story",
      silhouette: "Air Test",
      singleGender: "men",
      category: ["sneakers", "ignored"],
      details: "Leather details",
      upperMaterial: "Mesh",
      midsole: "Foam",
      technologies: [{ name: "Foam" }, { label: "Zoom Air" }],
      activitiesList: [{ name: "Running" }],
      tags: ["Limited", { value: "Performance" }],
      season: "2026",
    } satisfies JsonObject;
    const context = { source: source(), sourceProduct: { id: "2", sourceId: "1", sourceKey: "test-shirt", metadata: { route: "sneakers" } }, parts: [
      { partKey: "product", rawPayload: productPayload, parsedPayload: productPayload, adapterVersion: "1.0.0" },
      { partKey: "offers", rawPayload: jsonFixture("offers-empty.json"), parsedPayload: { market: "US", countryCode: "US", offers: [] }, adapterVersion: "1.0.0" },
    ] } satisfies ProcessingContext;

    const product = await processor.process(context);

    expect(product).toMatchObject({
      description: "Source story",
      attributes: {
        family: "Air Test",
        gender: "men",
        categoryRaw: "sneakers",
        story: "Source story",
        details: "Leather details",
        upperMaterial: "Mesh",
        midsole: "Foam",
      },
    });
    expect(product.referenceCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "product:model", typeCode: "model", sourceValue: "Test Shirt", context: { brand: "Example Brand", family: "Air Test" } }),
      expect.objectContaining({ key: "product:category", typeCode: "category", context: { route: "sneakers", productCategory: "apparel", productType: "tops", audience: "men" } }),
      expect.objectContaining({ key: "product:tag:technology:0", typeCode: "tag", scope: "product.tag.technology", sourceValue: "Foam" }),
      expect.objectContaining({ key: "product:tag:technology:1", typeCode: "tag", scope: "product.tag.technology", sourceValue: "Zoom Air" }),
      expect.objectContaining({ key: "product:activity:0", typeCode: "activity", scope: "product.activity", sourceValue: "Running" }),
      expect.objectContaining({ key: "product:tag:source:0", typeCode: "tag", scope: "product.tag.source", sourceValue: "Limited" }),
      expect.objectContaining({ key: "product:tag:source:1", typeCode: "tag", scope: "product.tag.source", sourceValue: "Performance" }),
    ]));
    expect(product.referenceCandidates.some((candidate) => candidate.scope === "product.tag.activity")).toBe(false);
    expect(product.referenceCandidates.filter((candidate) => candidate.scope === "product.tag.technology" && candidate.sourceValue === "Foam")).toHaveLength(1);
    expect(product.metadata).toMatchObject({ route: "sneakers" });
    expect(product.referenceCandidates.map((candidate) => candidate.typeCode)).not.toEqual(
      expect.arrayContaining(["product_family", "gender", "season"]),
    );
  });
  it("groups GOAT colorways by a stable model value without merging different models from one family", async () => {
    const processor = new GoatSourceProcessor();
    const process = async (id: string, name: string, color: string, silhouette: string) => {
      const productPayload = {
        ...(jsonFixture("product.json") as JsonObject),
        id,
        name,
        color,
        silhouette,
      } satisfies JsonObject;
      const context = { source: source(), sourceProduct: { id, sourceId: "1", sourceKey: id, metadata: {} }, parts: [
        { partKey: "product", rawPayload: productPayload, parsedPayload: productPayload, adapterVersion: "1.0.0" },
        { partKey: "offers", rawPayload: jsonFixture("offers-empty.json"), parsedPayload: { countryCode: "US", offers: [] }, adapterVersion: "1.0.0" },
      ] } satisfies ProcessingContext;
      const product = await processor.process(context);
      return product.referenceCandidates.find((candidate) => candidate.key === "product:model");
    };

    const black = await process("1", "YZY SL-01 'Black'", "Black", "YZY SL-01");
    const white = await process("2", "YZY SL-01 'White'", "White", "YZY SL-01");
    const golf = await process("3", "Under Armour Wmns Surge Golf 'White Clay'", "White Clay", "Surge");
    const fourth = await process("4", "Under Armour Surge 4 GS 'Serpentine'", "Serpentine", "Surge");
    const malformed = await process("5", "Hellstar Logo Slide 'Black", "Black", "Hellstar Logo Slide");

    expect(black).toMatchObject({ sourceValue: "YZY SL-01", context: { family: "YZY SL-01" } });
    expect(white).toMatchObject({ sourceValue: "YZY SL-01", context: { family: "YZY SL-01" } });
    expect(golf?.sourceValue).toBe("Under Armour Wmns Surge Golf");
    expect(fourth?.sourceValue).toBe("Under Armour Surge 4 GS");
    expect(malformed?.sourceValue).toBe("Hellstar Logo Slide");
  });
});

describe("GOAT HTTP classification", () => {
  it.each([403, 408, 425, 429, 500, 503])("classifies HTTP %s as retryable", (status) => { expect(() => assertGoatHttpStatus(status, "https://www.goat.com/web-api/x")).toThrow(RetryableError); });
  it("classifies product 404 and other 4xx as permanent", () => { expect(() => assertGoatHttpStatus(404, "https://www.goat.com/web-api/v1/product_templates/missing")).toThrow(PermanentError); expect(() => assertGoatHttpStatus(422, "https://www.goat.com/web-api/x")).toThrow(PermanentError); });
  it("recognizes sanitized challenge HTML", () => { expect(isGoatHtmlChallenge(fixture("challenge.html"))).toBe(true); });
  it("masks proxy credentials", () => { expect(maskProxyCredentials("failed via http://login:password@127.0.0.1:8080")).toBe("failed via http://***:***@127.0.0.1:8080"); });
});
