import { matchExistingWordPressVariations } from "../../src/integrations/wordpress/wordpress-variation-patch-builder.js";
import { WordPressSizeConverter } from "../../src/integrations/wordpress/wordpress-size-converter.js";
import { describe, expect, it, vi } from "vitest";

import type { ExportContext, JsonObject, UniversalProductDTO } from "../../src/contracts/index.js";
import { IntegrationContractError, RetryableError } from "../../src/core/errors/index.js";
import { hashStableJson } from "../../src/core/utils/index.js";
import { buildWordPressUpsertPayload, previewWordPressUpsertPayload, previewWordPressVariationPatchItems, WordPressExporter, type WordPressSizeConverterLike } from "../../src/integrations/index.js";

const product: UniversalProductDTO = {
  sourceProductId: "2",
  title: "Nike Test Shoe",
  description: "Source description",
  sku: "ROOT-SKU",
  images: [{
    url: "https://parser.example/images/test-1.webp",
    sourceUrl: "https://source.example/test.png",
    sourceContentHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    perceptualHash: "0123456789abcdef",
    position: 0,
    alt: "Test",
    attributes: {},
  }],
  variants: [{
    sourceVariantKey: "offer-7",
    sku: "ROOT-SKU-7",
    size: { sourceValue: "7", displayValue: "7", system: "us-numeric", audience: "men" },
    price: { amount: "123.45", currency: "USD" },
    inventory: { availability: "available" },
    attributes: {},
  }],
  referenceCandidates: [],
  classification: {
    status: "complete",
    classifierVersion: "1",
    fingerprint: "classification",
    resolved: [
      { candidateKey: "product:brand", typeCode: "brand", scope: "product.brand", subjectKind: "product", referenceValueId: "11", resolutionKind: "mapping", resolutionId: "21", resolutionRevision: "1" },
      { candidateKey: "product:category", typeCode: "category", scope: "product.category", subjectKind: "product", referenceValueId: "12", resolutionKind: "mapping", resolutionId: "22", resolutionRevision: "1" },
    ],
    ignored: [],
    unresolved: [],
  },
  translatedContent: { providerCode: "deepl", providerVersion: "1.0.0", sourceLocale: "en", targetLocale: "ru", description: "Описание", story: "История", color: "Черный", details: "Black", upperMaterial: "Кожа" },
  attributes: { color: "Black", details: "Black/White", upperMaterial: "Leather", midsole: "Air", categoryRaw: "sneakers", releaseDate: "2026-01-02T23:59:59.999Z" },
  metadata: {},
};

function context(config: JsonObject = {}): ExportContext {
  return {
    source: { id: "1", code: "goat", config: {} },
    sourceProduct: { id: "2", sourceId: "1", sourceKey: "shoe", externalId: "100", slug: "nike-test-shoe", metadata: {} },
    target: {
      id: "10",
      code: "slamdunk",
      config: {
        requiredReferenceTypes: ["brand", "category"],
        sizeMappings: [{ sourceValue: "7", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 107 }],
        ...config,
      },
    },
    product,
    references: {
      resolveReference: vi.fn(async ({ referenceType }) => referenceType === "brand"
        ? { externalValue: "31", externalLabel: "Nike" }
        : referenceType === "model"
          ? { externalValue: "51", externalLabel: "Nike Test" }
          : { externalValue: "41", externalLabel: "Кроссовки" }),
      resolveProjections: vi.fn().mockResolvedValue([]),
      resolveAssignments: vi.fn().mockResolvedValue([]),
    },
  };
}

describe("WordPressExporter", () => {
  it("lets a v2 replacement set a category directly when an old internal category cannot map", async () => {
    const base = context();
    const direct: ExportContext = {
      ...base,
      product: { ...base.product, classification: { ...base.product.classification!, execution: { mode: "v2", revision: "5" } } },
      references: { ...base.references,
        resolveReference: vi.fn(async ({ referenceType }) => {
          if (referenceType === "brand") return { externalValue: "31", externalLabel: "Nike" };
          throw new Error("Old category mapping is missing");
        }),
        resolveAssignments: vi.fn().mockResolvedValue([{ targetScope: "product.category", externalValue: "41", externalLabel: "Кроссовки", mode: "replace" }]),
      },
    };
    const payload = await buildWordPressUpsertPayload(direct);
    expect(((payload.product as JsonObject).taxonomies as JsonObject).product_cat).toEqual({ mode: "replace", term_ids: [41] });
    await expect(buildWordPressUpsertPayload({ ...direct, references: { ...direct.references,
      resolveAssignments: vi.fn().mockResolvedValue([{ targetScope: "product.category", externalValue: "41", externalLabel: "Кроссовки", mode: "add" }]),
    } })).rejects.toThrow();
  });

  it("keeps the declared source brand for size conversion when v2 adds a collaboration brand", async () => {
    const base = context();
    const input: ExportContext = { ...base,
      product: { ...base.product, classification: { ...base.product.classification!, execution: { mode: "v2", revision: "5" } },
        variants: [{ ...base.product.variants[0]!, size: { sourceValue: "40", displayValue: "40", system: "eu-numeric", audience: "men" } }] },
      references: { ...base.references, resolveAssignments: vi.fn().mockResolvedValue([
        { targetScope: "product.brand", externalValue: "31", externalLabel: "Nike", mode: "add", primarySourceBrand: true },
        { targetScope: "product.brand", externalValue: "99", externalLabel: "Other", mode: "add" },
      ]) },
    };
    const converter = { supports: vi.fn(() => true), convert: vi.fn(async () =>
      ({ sourceValue: "7", displayValue: "7", system: "us-numeric" as const, audience: "men" as const })) };
    const payload = await buildWordPressUpsertPayload(input, converter);
    expect(converter.convert).toHaveBeenCalledWith(expect.objectContaining({ brandTermId: 31 }));
    expect((((payload.product as JsonObject).taxonomies as JsonObject).pa_brand as JsonObject).term_ids).toEqual([31, 99]);
  });

  it("accepts reviewed existing translations when switching the required provider", async () => {
    const requiredTranslation = { providerCode: "openrouter", providerVersion: "1.0.0:deepseek/deepseek-v3.2", sourceLocale: "en", targetLocale: "ru" };
    const acceptedTranslations = [{ providerCode: "deepl", providerVersion: "1.0.0", sourceLocale: "en", targetLocale: "ru" }];
    await expect(buildWordPressUpsertPayload(context({ requiredTranslation }))).rejects.toThrow();
    await expect(buildWordPressUpsertPayload(context({ requiredTranslation, acceptedTranslations }))).resolves.toBeDefined();
    await expect(buildWordPressUpsertPayload(context({ requiredTranslation, acceptedTranslations: [{ ...acceptedTranslations[0], targetLocale: "de" }] }))).rejects.toThrow("locales");
  });
  it("keeps reviewed native sizes separate in full export and inventory without leaking to other products", async () => {
    const base = context({ nativeSizeProfiles: [{ sourceProductIds: ["2"], sizeMappings: [
      { sourceValue: "40.5", system: "eu-numeric", audience: "men", taxonomy: "pa_razmer", termId: 9405 },
      { sourceValue: "41", system: "eu-numeric", audience: "men", taxonomy: "pa_razmer", termId: 9410 },
    ] }] });
    const input: ExportContext = { ...base, product: { ...base.product, variants: ["40.5", "41"].map((value) => ({
      ...base.product.variants[0]!, sourceVariantKey: `eu-${value}`,
      size: { sourceValue: value, displayValue: value, system: "eu-numeric", audience: "men" as const },
    })) } };
    const original = structuredClone(input.product);
    const converter = { supports: vi.fn(() => true), convert: vi.fn(async () => ({
      sourceValue: "7", displayValue: "7", system: "us-numeric", audience: "men" as const,
    })) };
    const preview = await previewWordPressUpsertPayload(input, converter);
    const full = await buildWordPressUpsertPayload(input, converter);
    const live = await previewWordPressVariationPatchItems({ ...input, liveVariants: input.product.variants }, converter);
    const expected = [9405, 9410].map((term_id) => ({ size: { taxonomy: "pa_razmer", term_id } }));
    expect((preview.payload.variations as JsonObject).items).toMatchObject(expected);
    expect((full.variations as JsonObject).items).toMatchObject(expected);
    expect(live.items).toMatchObject(expected);
    expect(converter.convert).not.toHaveBeenCalled();
    expect(input.product).toEqual(original);
    expect(() => matchExistingWordPressVariations(live, { product: { variations: [
      { variation_id: 500, stock_status: "instock", attributes: [{ taxonomy: "pa_razmer", term_id: 107 }] },
    ] } })).toThrow("requires full product synchronization");
    const other = { ...input, sourceProduct: { ...input.sourceProduct, id: "3" } };
    await expect(buildWordPressUpsertPayload(other, converter)).rejects.toThrow("same WordPress size");
    expect(converter.convert).toHaveBeenCalledTimes(2);
  });

  it("does not convert a missing native size or accept overlapping native profiles", async () => {
    const profile = { sourceProductIds: ["2"], sizeMappings: [
      { sourceValue: "41", system: "eu-numeric", audience: "men", taxonomy: "pa_razmer", termId: 9410 },
    ] };
    const input = context({ nativeSizeProfiles: [profile] });
    const converter = { supports: vi.fn(() => true), convert: vi.fn() };
    await expect(buildWordPressUpsertPayload(input, converter)).rejects.toThrow("size mapping is missing");
    expect(converter.convert).not.toHaveBeenCalled();
    await expect(buildWordPressUpsertPayload(context({ nativeSizeProfiles: [profile, profile] })))
      .rejects.toThrow("More than one native size profile");
  });

  function childContext(): ExportContext {
    const base = context({ sizeMappings: [
      { sourceValue: "3", system: "us-numeric", audience: "youth", taxonomy: "pa_razmer", termId: 1412 },
      { sourceValue: "10.5", system: "us-numeric", audience: "youth", taxonomy: "pa_razmer", termId: 1551 },
      { sourceValue: "10.5", system: "us-numeric", audience: "infant", taxonomy: "pa_razmer", termId: 1401 },
      { sourceValue: "11.5", system: "us-numeric", audience: "infant", taxonomy: "pa_razmer", termId: 1403 },
      { sourceValue: "12.5", system: "us-numeric", audience: "infant", taxonomy: "pa_razmer", termId: 1405 },
      { sourceValue: "13.5", system: "us-numeric", audience: "infant", taxonomy: "pa_razmer", termId: 1407 },
    ] });
    return { ...base, product: { ...base.product, metadata: { route: "sneakers" },
      variants: ["3", "10.5", "11.5", "12.5", "13.5"].map((value) => ({ ...base.product.variants[0]!,
        sourceVariantKey: `child-${value}`, sku: `CHILD-${value}`,
        size: { sourceValue: value, displayValue: value, system: "us-numeric", audience: "youth" as const },
      })) } };
  }

  it("uses the same corrected child terms in preview, full export and live inventory", async () => {
    const input = childContext();
    const original = structuredClone(input.product);
    const preview = await previewWordPressUpsertPayload(input);
    const payload = await buildWordPressUpsertPayload(input);
    const live = await previewWordPressVariationPatchItems({ ...input, liveVariants: input.product.variants });
    const expected = [1412, 1401, 1403, 1405, 1407].map((term_id) => ({ size: { taxonomy: "pa_razmer", term_id } }));
    expect((preview.payload.variations as JsonObject).items).toMatchObject(expected);
    expect((payload.variations as JsonObject).items).toMatchObject(expected);
    expect(live.items).toMatchObject(expected);
    expect(preview.ignoredSizeVariants).toEqual([]);
    expect(live.replacedTargetSizes).toEqual(["pa_razmer:1551"]);
    expect(input.product).toEqual(original);
    expect(live.items.map((item) => item.source_variant_key)).toEqual(input.product.variants.map((variant) => variant.sourceVariantKey));
    const refreshed = await previewWordPressUpsertPayload({ ...input, liveVariants: [input.product.variants[2]!] });
    expect((refreshed.payload.variations as JsonObject).items).toMatchObject([expected[2]]);
  });

  it("requires exact K mappings and never falls back to Y or an audience-free mapping", async () => {
    const base = childContext();
    const input = { ...base, target: { ...base.target, config: { ...base.target.config,
      sizeMappings: [
        { sourceValue: "3", system: "us-numeric", audience: "youth", taxonomy: "pa_razmer", termId: 1412 },
        { sourceValue: "10.5", system: "us-numeric", audience: "youth", taxonomy: "pa_razmer", termId: 1551 },
        { sourceValue: "10.5", taxonomy: "pa_razmer", termId: 1551 },
      ],
    } } };
    await expect(buildWordPressUpsertPayload(input)).rejects.toThrow("us-numeric/infant/10.5");
    const partial = await previewWordPressUpsertPayload({ ...input, target: { ...input.target,
      config: { ...input.target.config, ignoreUnmappedSizeVariants: true } } });
    expect((partial.payload.variations as JsonObject).items).toHaveLength(1);
    expect(partial.ignoredSizeVariants).toHaveLength(4);
    expect(partial.ignoredSizeVariants[0]).toMatchObject({ sourceValue: "10.5", audience: "youth",
      reason: expect.stringContaining("us-numeric/infant/10.5") });
  });

  it("blocks inventory-only updates of old Y variations until full synchronization", async () => {
    const draft = await previewWordPressVariationPatchItems(childContext());
    const oldSnapshot = { product: { variations: [
      { variation_id: 500, attributes: [{ taxonomy: "pa_razmer", term_id: 1551 }] },
    ] } };
    expect(() => matchExistingWordPressVariations(draft, oldSnapshot)).toThrow("requires full product synchronization");
    const repaired = matchExistingWordPressVariations(draft, { product: { variations: [
      { variation_id: 500, attributes: [{ taxonomy: "pa_razmer", term_id: 1401 }] },
      { variation_id: 501, stock_status: "outofstock", attributes: [{ taxonomy: "pa_razmer", term_id: 1551 }] },
    ] } });
    expect(repaired.items).toContainEqual(expect.objectContaining({ variation_id: 500, size: { taxonomy: "pa_razmer", term_id: 1401 } }));
  });

  it("keeps a converted range as one exact target size", async () => {
    const base = context({ sizeMappings: [
      { sourceValue: "7-7.5", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 26209 },
    ] });
    const input: ExportContext = { ...base, product: { ...base.product, variants: [{
      ...base.product.variants[0]!, size: { sourceValue: "40", displayValue: "40", system: "eu-numeric", audience: "men" },
    }] } };
    const request = vi.fn(async () => new Response(JSON.stringify({ conversion_table: { "40": "7-7,5" }, conflicts: {} })));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token",
      timeoutMs: 1000, jobTimeoutMs: 1000, pollIntervalMs: 10 }, request);
    const result = await exporter.previewPayload(input);
    const variants = (result.payload.variations as JsonObject).items;
    expect(variants).toMatchObject([{ size: { taxonomy: "pa_razmer", term_id: 26209 } }]);
    expect(variants).toHaveLength(1);
    expect(result.ignoredSizeVariants).toEqual([]);
  });

  it("reloads corrected size tables between payloads while sharing one table across their variants", async () => {
    const base = context({ sizeMappings: [
      { sourceValue: "7", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 107 },
      { sourceValue: "8", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 108 },
    ] });
    const input: ExportContext = { ...base, product: { ...base.product, variants: ["40", "41"].map((size) => ({
      ...base.product.variants[0]!, sourceVariantKey: `eu-${size}`, sku: `EU-${size}`,
      size: { sourceValue: size, displayValue: size, system: "eu-numeric", audience: "men" as const },
    })) } };
    let conflicting = true;
    const request = vi.fn(async () => new Response(JSON.stringify({
      conversion_table: { "40": "7", "41": "8" }, conflicts: conflicting ? { "40": ["7", "10"] } : {},
    })));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token",
      timeoutMs: 1000, jobTimeoutMs: 1000, pollIntervalMs: 10 }, request);
    await expect(exporter.previewPayload(input)).rejects.toThrow("size conversion is ambiguous");
    conflicting = false;
    await expect(exporter.previewPayload(input)).resolves.toHaveProperty("payload");
    expect(request).toHaveBeenCalledTimes(2);
    conflicting = true;
    await expect(exporter.buildPayload(input)).rejects.toThrow("size conversion is ambiguous");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("reports a missing conversion row as an omitted variant only under the explicit policy", async () => {
    const base = context({ ignoreUnmappedSizeVariants: true,
      sizeMappings: [{ sourceValue: "8", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 108 }] });
    const input: ExportContext = { ...base, product: { ...base.product, variants: ["36", "41"].map((size) => ({
      ...base.product.variants[0]!, sourceVariantKey: `eu-${size}`, sku: `EU-${size}`,
      size: { sourceValue: size, displayValue: size, system: "eu-numeric", audience: "men" as const },
    })) } };
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversion_table: { "41": "8" }, conflicts: {} })));
    const converter = new WordPressSizeConverter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 1000, jobTimeoutMs: 1000, pollIntervalMs: 10 }, request);
    const preview = await previewWordPressUpsertPayload(input, converter);
    expect((preview.payload.variations as JsonObject).items).toHaveLength(1);
    expect(preview.ignoredSizeVariants).toEqual([expect.objectContaining({ sourceValue: "36", reason: "WordPress size conversion is missing: eu-numeric/men/36" })]);
    await expect(buildWordPressUpsertPayload({ ...input, target: { ...input.target,
      config: { ...input.target.config, ignoreUnmappedSizeVariants: false } } }, converter)).rejects.toThrow("conversion is missing");
    await expect(buildWordPressUpsertPayload({ ...input, product: { ...input.product, variants: [input.product.variants[0]!] } }, converter)).rejects.toThrow("no variants with mapped sizes");
  });

  it.each(["conflict", "missing-table"])("keeps %s errors blocking even when partial sizes are allowed", async (failure) => {
    const base = context({ ignoreUnmappedSizeVariants: true });
    const input: ExportContext = { ...base, product: { ...base.product, variants: base.product.variants.map((variant) => ({
      ...variant, size: { sourceValue: "41", displayValue: "41", system: "eu-numeric", audience: "men" as const },
    })) } };
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(failure === "conflict"
      ? { conversion_table: {}, conflicts: { "41": ["7", "8"] } }
      : { code: "size_table_not_found", message: "missing table" }), { status: failure === "conflict" ? 200 : 404 }));
    const converter = new WordPressSizeConverter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 1000, jobTimeoutMs: 1000, pollIntervalMs: 10 }, request);
    await expect(previewWordPressUpsertPayload(input, converter)).rejects.toThrow(failure === "conflict" ? "ambiguous" : "missing table");
  });

  it("requires the configured current translation before building a full payload", async () => {
    const requiredTranslation = { providerCode: "deepl", providerVersion: "1.0.0", sourceLocale: "en", targetLocale: "ru" };
    await expect(buildWordPressUpsertPayload(context({ requiredTranslation }))).resolves.toBeDefined();

    const base = context({ requiredTranslation });
    const { translatedContent: _translatedContent, ...untranslatedProduct } = base.product;
    await expect(buildWordPressUpsertPayload({
      ...base,
      product: untranslatedProduct,
    })).rejects.toThrow("Для выгрузки WordPress требуется актуальный перевод deepl 1.0.0 en→ru");
  });

  it("marks only the x5 price outlier unavailable in a full product payload", async () => {
    const base = context({
      maxVariantPriceRatio: 5,
      sizeMappings: [
        { sourceValue: "7", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 107 },
        { sourceValue: "8", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 108 },
      ],
    });
    const input: ExportContext = {
      ...base,
      product: {
        ...base.product,
        variants: [
          ...base.product.variants,
          {
            ...base.product.variants[0]!,
            sourceVariantKey: "offer-8",
            sku: "ROOT-SKU-8",
            size: { sourceValue: "8", displayValue: "8", system: "us-numeric", audience: "men" },
            price: { amount: "700.00", currency: "USD" },
          },
        ],
      },
    };

    const payload = await buildWordPressUpsertPayload(input);
    const variations = (payload.variations as JsonObject).items as readonly JsonObject[];
    expect(variations).toHaveLength(2);
    expect(variations[1]).toMatchObject({
      source_variant_key: "offer-8",
      price: null,
      inventory: { availability: "unavailable", quantity: 0 },
    });
  });

  it("marks the x5 price outlier unavailable in a variation-only patch", async () => {
    const base = context({
      maxVariantPriceRatio: 5,
      sizeMappings: [
        { sourceValue: "7", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 107 },
        { sourceValue: "8", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 108 },
      ],
    });
    const input: ExportContext = {
      ...base,
      liveVariants: [
        base.product.variants[0]!,
        { ...base.product.variants[0]!, sourceVariantKey: "offer-8", sku: "ROOT-SKU-8",
          size: { sourceValue: "8", displayValue: "8", system: "us-numeric", audience: "men" },
          price: { amount: "700.00", currency: "USD" } },
      ],
    };
    const draft = await previewWordPressVariationPatchItems(input);
    expect(draft.items).toHaveLength(2);
    expect(draft.items[0]?.source_variant_key).toBe("offer-7");
    expect(draft.items[1]).toMatchObject({
      source_variant_key: "offer-8",
      price: null,
      inventory: { availability: "unavailable", quantity: 0 },
    });
    expect(draft.ignored).toEqual([expect.objectContaining({ sourceVariantKey: "offer-8", reason: expect.stringContaining("x5") })]);
  });

  it("builds the strict source-neutral upsert payload", async () => {
    const payload = await buildWordPressUpsertPayload(context());
    const identity = payload.identity as JsonObject;
    const targetProduct = payload.product as JsonObject;
    const variations = payload.variations as JsonObject;
    const item = (variations.items as readonly JsonObject[])[0]!;

    expect(identity).toEqual({ source_code: "goat", source_external_id: "100", external_key: "goat:100", target_id: 0 });
    expect(targetProduct.taxonomies).toEqual({ pa_brand: { mode: "replace", term_ids: [31] }, product_cat: { mode: "replace", term_ids: [41] } });
    expect(targetProduct.images).toEqual([{
      url: "https://parser.example/images/test-1.webp",
      filename: "test-1.webp",
      source_url: "https://source.example/test.png",
      source_content_hash: "a".repeat(64),
      content_hash: "b".repeat(64),
      perceptual_hash: "0123456789abcdef",
    }]);
    expect(targetProduct.description_html).toContain("<li>Технология: Air</li>");
    expect(targetProduct.description_html).toContain("<li>Категория: sneakers</li>");
    expect(targetProduct.description_html).toContain("<li>Дата релиза: 02 января 2026г.</li>");
    expect(payload.content_policy).toEqual({ description: { mode: "prefer_existing", required: false, fallback_source: "source_story" } });
    expect(payload.managed_fields).not.toContain("sku");
    expect(payload.managed_fields).not.toContain("slug");
    expect(targetProduct.sku).toBe("ROOT-SKU");
    expect(targetProduct).not.toHaveProperty("slug");
    expect(payload.managed_fields).not.toContain("short_description");
    expect(targetProduct).not.toHaveProperty("short_description_html");
    expect(item).toMatchObject({ variation_key: "goat:100|offer-7", sku: "ROOT-SKU-7", size: { taxonomy: "pa_razmer", term_id: 107 }, price: { source_currency: "USD", source_minor_amount: "12345" }, inventory: { availability: "available" } });
    expect((item.inventory as JsonObject).quantity).toBeUndefined();
    expect(String(payload.idempotency_key)).toMatch(/^product-upsert:v2:[a-f0-9]{64}$/u);
    expect(String(payload.payload_hash)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses target scope overrides and the most specific size mapping", async () => {
    const input = context({
      targetScopeMap: { "product.brand": "catalog.brand" },
      sizeMappings: [
        { sourceValue: "7", taxonomy: "pa_razmer", termId: 100 },
        { sourceValue: "7", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 107 },
      ],
    });

    const payload = await buildWordPressUpsertPayload(input);
    const variations = payload.variations as JsonObject;
    const item = (variations.items as readonly JsonObject[])[0]!;

    expect(input.references.resolveReference).toHaveBeenCalledWith(expect.objectContaining({ referenceType: "brand", targetScope: "catalog.brand" }));
    expect(item.size).toEqual({ taxonomy: "pa_razmer", term_id: 107 });
  });

  it("gives an existing WordPress description priority over the source fallback", async () => {
    const base = context();
    const input: ExportContext = {
      ...base,
      product: { ...base.product, translatedContent: { ...base.product.translatedContent!, story: "" } },
      contentTemplates: [{
        id: "300", field: "description", revision: 1,
        templateSource: "<h2>{{ product.effective_title }}</h2>{% if content.story %}{{ content.story | paragraphs }}{% endif %}<ul><li>Артикул: {{ product.sku }}</li></ul>",
        profileKey: "default", profileName: "Основной профиль", managementMode: "manage", categoryTermIds: [],
        requiredContextPaths: ["content.story"],
      }],
    };

    const payload = await buildWordPressUpsertPayload(input);
    expect((payload.product as JsonObject).description_html).toContain("Описание");
    expect(payload.content_policy).toEqual({ description: { mode: "prefer_existing", required: true, fallback_source: "source_description" } });
  });

  it("applies the winning target assignment after direct category mappings", async () => {
    const input = context();
    vi.mocked(input.references.resolveAssignments).mockResolvedValueOnce([
      { ruleId: "300", groupCode: "sandal_leaf", targetScope: "product.category", externalValue: "900", externalLabel: "Сабо", mode: "replace" },
    ]);

    const payload = await buildWordPressUpsertPayload(input);
    expect((payload.product as JsonObject).taxonomies).toEqual({
      pa_brand: { mode: "replace", term_ids: [31] },
      product_cat: { mode: "replace", term_ids: [900] },
    });
  });

  it("applies replacements before additions regardless of assignment order", async () => {
    const input = context();
    vi.mocked(input.references.resolveAssignments).mockResolvedValueOnce([
      { ruleId: "301", groupCode: "seasonal_category", targetScope: "product.category", externalValue: "901", externalLabel: "Сезонная", mode: "add" },
      { ruleId: "300", groupCode: "sandal_leaf", targetScope: "product.category", externalValue: "900", externalLabel: "Сабо", mode: "replace" },
    ]);

    const payload = await buildWordPressUpsertPayload(input);

    expect((payload.product as JsonObject).taxonomies).toEqual({
      pa_brand: { mode: "replace", term_ids: [31] },
      product_cat: { mode: "replace", term_ids: [901, 900] },
    });
  });

  it("adds secondary WordPress brands and models without replacing the primary values", async () => {
    const base = context();
    const input: ExportContext = {
      ...base,
      product: {
        ...base.product,
        classification: {
          ...base.product.classification!,
          resolved: [
            ...base.product.classification!.resolved,
            { candidateKey: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product", referenceValueId: "13", resolutionKind: "mapping", resolutionId: "23", resolutionRevision: "1" },
          ],
        },
      },
    };
    vi.mocked(input.references.resolveReference).mockImplementation(async ({ referenceType }) => {
      if (referenceType === "brand") return { externalValue: "31", externalLabel: "adidas" };
      if (referenceType === "model") return { externalValue: "51", externalLabel: "adidas Samba" };
      return { externalValue: "41", externalLabel: "Кроссовки" };
    });
    vi.mocked(input.references.resolveAssignments).mockResolvedValueOnce([
      { ruleId: "401", groupCode: "additional_brand_clarks", targetScope: "product.brand", externalValue: "32", externalLabel: "Clarks", mode: "add" },
      { ruleId: "402", groupCode: "additional_model_8th_street", targetScope: "product.model", externalValue: "52", externalLabel: "adidas 8th Street Samba", mode: "add" },
    ]);

    const payload = await buildWordPressUpsertPayload(input);

    expect((payload.product as JsonObject).taxonomies).toEqual({
      pa_brand: { mode: "replace", term_ids: [31, 32] },
      pa_model: { mode: "replace", term_ids: [51, 52] },
      product_cat: { mode: "replace", term_ids: [41] },
    });
  });

  it("keeps existing WordPress brands when the target setting is enabled", async () => {
    const input: ExportContext = {
      ...context({ preserveExistingBrandTerms: true }),
      existingExternalId: "321",
      existingTargetSnapshot: {
        product: {
          taxonomies: {
            pa_brand: [
              { term_id: 31, name: "Nike", slug: "nike" },
              { term_id: 5490, name: "Clarks", slug: "clarks" },
            ],
          },
        },
      },
    };

    const payload = await buildWordPressUpsertPayload(input);

    expect((payload.product as JsonObject).taxonomies).toEqual({
      pa_brand: { mode: "replace", term_ids: [31, 5490] },
      product_cat: { mode: "replace", term_ids: [41] },
    });
  });

  it("keeps existing WordPress tags and adds tags resolved by current rules", async () => {
    const input: ExportContext = {
      ...context({ preserveExistingTagTerms: true }),
      existingExternalId: "321",
      existingTargetSnapshot: {
        product: {
          taxonomies: {
            product_tag: [{ term_id: 900, name: "Старая метка", slug: "old-tag" }],
          },
        },
      },
    };
    vi.mocked(input.references.resolveProjections).mockResolvedValue([
      { resolutionKind: "mapping", resolutionId: "22", targetScope: "product.tag", externalValue: "901", externalLabel: "Новая метка", externalSlug: "new-tag" },
    ]);

    const payload = await buildWordPressUpsertPayload(input);

    expect(((payload.product as JsonObject).taxonomies as JsonObject).product_tag).toEqual({
      mode: "replace",
      term_ids: [900, 901],
    });
  });

  it("keeps Air Jordan 1 Retro High instead of replacing it with the broader Air Jordan 1", async () => {
    const base = context({ preferSpecificExistingModelTerms: true });
    const input: ExportContext = {
      ...base,
      existingExternalId: "321",
      existingTargetSnapshot: { product: { taxonomies: {
        pa_model: [{ term_id: 14777, name: "Air Jordan 1 Retro High", slug: "air-jordan-1-retro-high" }],
      } } },
      product: {
        ...base.product,
        referenceCandidates: [{
          key: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product",
          sourceValue: "Wmns Air Jordan 1 Retro High OG 'First in Flight'", context: { brand: "Air Jordan", family: "Air Jordan 1" }, evidence: {},
        }],
        classification: { ...base.product.classification!, resolved: [
          ...base.product.classification!.resolved,
          { candidateKey: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product", referenceValueId: "13", resolutionKind: "rule", resolutionId: "35", resolutionRevision: "1" },
        ] },
      },
    };
    vi.mocked(input.references.resolveReference).mockImplementation(async ({ referenceType }) => referenceType === "model"
      ? { externalValue: "14787", externalLabel: "Air Jordan 1" }
      : referenceType === "brand"
        ? { externalValue: "31", externalLabel: "Air Jordan" }
        : { externalValue: "41", externalLabel: "Кроссовки" });

    const payload = await buildWordPressUpsertPayload(input);

    expect(((payload.product as JsonObject).taxonomies as JsonObject).pa_model).toEqual({
      mode: "replace", term_ids: [14777],
    });
  });

  it("treats WordPress Retro and GOAT Hi naming as the same high-top model", async () => {
    const base = context({ preferSpecificExistingModelTerms: true });
    const input: ExportContext = {
      ...base,
      existingExternalId: "321",
      existingTargetSnapshot: { product: { taxonomies: {
        pa_model: [{ term_id: 14777, name: "Air Jordan 1 Retro High", slug: "air-jordan-1-retro-high" }],
      } } },
      product: {
        ...base.product,
        referenceCandidates: [{
          key: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product",
          sourceValue: "Air Jordan 1 Hi OG 'Chicago'", context: { brand: "Air Jordan", family: "Air Jordan 1" }, evidence: {},
        }],
        classification: { ...base.product.classification!, resolved: [
          ...base.product.classification!.resolved,
          { candidateKey: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product", referenceValueId: "13", resolutionKind: "rule", resolutionId: "35", resolutionRevision: "1" },
        ] },
      },
    };
    vi.mocked(input.references.resolveReference).mockImplementation(async ({ referenceType }) => referenceType === "model"
      ? { externalValue: "14787", externalLabel: "Air Jordan 1" }
      : referenceType === "brand"
        ? { externalValue: "31", externalLabel: "Air Jordan" }
        : { externalValue: "41", externalLabel: "Кроссовки" });

    const payload = await buildWordPressUpsertPayload(input);

    expect(((payload.product as JsonObject).taxonomies as JsonObject).pa_model).toEqual({
      mode: "replace", term_ids: [14777],
    });
  });

  it("does not keep a legacy Retro High term when the source has no high-top evidence", async () => {
    const base = context({ preferSpecificExistingModelTerms: true });
    const input: ExportContext = {
      ...base,
      existingExternalId: "321",
      existingTargetSnapshot: { product: { taxonomies: {
        pa_model: [{ term_id: 14777, name: "Air Jordan 1 Retro High", slug: "air-jordan-1-retro-high" }],
      } } },
      product: {
        ...base.product,
        referenceCandidates: [{
          key: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product",
          sourceValue: "Air Jordan 1 Anodized 'Silver'", context: { brand: "Air Jordan", family: "Air Jordan 1" }, evidence: {},
        }],
        classification: { ...base.product.classification!, resolved: [
          ...base.product.classification!.resolved,
          { candidateKey: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product", referenceValueId: "13", resolutionKind: "rule", resolutionId: "35", resolutionRevision: "1" },
        ] },
      },
    };
    vi.mocked(input.references.resolveReference).mockImplementation(async ({ referenceType }) => referenceType === "model"
      ? { externalValue: "14787", externalLabel: "Air Jordan 1" }
      : referenceType === "brand"
        ? { externalValue: "31", externalLabel: "Air Jordan" }
        : { externalValue: "41", externalLabel: "Кроссовки" });

    const payload = await buildWordPressUpsertPayload(input);

    expect(((payload.product as JsonObject).taxonomies as JsonObject).pa_model).toEqual({
      mode: "replace", term_ids: [14787],
    });
  });

  it("recognizes Nike SB Dunk High when the source and target words use a different order", async () => {
    const base = context({ preferSpecificExistingModelTerms: true });
    const input: ExportContext = {
      ...base,
      existingExternalId: "321",
      existingTargetSnapshot: { product: { taxonomies: {
        pa_model: [{ term_id: 14746, name: "Nike SB Dunk High", slug: "nike-sb-dunk-high" }],
      } } },
      product: {
        ...base.product,
        referenceCandidates: [{
          key: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product",
          sourceValue: "Nike Dunk High Pro SB 'Mineral Slate'", context: { brand: "Nike", family: "Dunk SB" }, evidence: {},
        }],
        classification: { ...base.product.classification!, resolved: [
          ...base.product.classification!.resolved,
          { candidateKey: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product", referenceValueId: "13", resolutionKind: "rule", resolutionId: "1415", resolutionRevision: "1" },
        ] },
      },
    };
    vi.mocked(input.references.resolveReference).mockImplementation(async ({ referenceType }) => referenceType === "model"
      ? { externalValue: "16136", externalLabel: "Nike Dunk SB" }
      : referenceType === "brand"
        ? { externalValue: "31", externalLabel: "Nike" }
        : { externalValue: "41", externalLabel: "Кроссовки" });
    vi.mocked(input.references.resolveProjections).mockResolvedValue([{
      resolutionKind: "rule", resolutionId: "1415", targetScope: "product.model",
      externalValue: "16096", externalLabel: "Nike Dunk", externalSlug: "nike-dunk",
    }]);
    vi.mocked(input.references.resolveAssignments).mockResolvedValueOnce([{
      ruleId: "500", groupCode: "collaboration_model", targetScope: "product.model",
      externalValue: "19999", externalLabel: "Concepts Collaboration", mode: "add",
    }]);

    const payload = await buildWordPressUpsertPayload(input);

    expect(((payload.product as JsonObject).taxonomies as JsonObject).pa_model).toEqual({
      mode: "replace", term_ids: [14746, 19999],
    });
  });

  it("does not refine a model selected by an explicit replace assignment", async () => {
    const base = context({ preferSpecificExistingModelTerms: true });
    const input: ExportContext = {
      ...base,
      existingExternalId: "321",
      existingTargetSnapshot: { product: { taxonomies: {
        pa_model: [{ term_id: 14777, name: "Air Jordan 1 Retro High", slug: "air-jordan-1-retro-high" }],
      } } },
      product: {
        ...base.product,
        referenceCandidates: [{
          key: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product",
          sourceValue: "Wmns Air Jordan 1 Retro High OG 'First in Flight'", context: { brand: "Air Jordan", family: "Air Jordan 1" }, evidence: {},
        }],
        classification: { ...base.product.classification!, resolved: [
          ...base.product.classification!.resolved,
          { candidateKey: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product", referenceValueId: "13", resolutionKind: "rule", resolutionId: "35", resolutionRevision: "1" },
        ] },
      },
    };
    vi.mocked(input.references.resolveReference).mockImplementation(async ({ referenceType }) => referenceType === "model"
      ? { externalValue: "14787", externalLabel: "Air Jordan 1" }
      : referenceType === "brand"
        ? { externalValue: "31", externalLabel: "Air Jordan" }
        : { externalValue: "41", externalLabel: "Кроссовки" });
    vi.mocked(input.references.resolveAssignments).mockResolvedValueOnce([{
      ruleId: "501", groupCode: "exact_model", targetScope: "product.model",
      externalValue: "18888", externalLabel: "Air Jordan 1 High OG", mode: "replace",
    }]);

    const payload = await buildWordPressUpsertPayload(input);

    expect(((payload.product as JsonObject).taxonomies as JsonObject).pa_model).toEqual({
      mode: "replace", term_ids: [18888],
    });
  });

  it("keeps a newly calculated model when it is more specific than the existing model", async () => {
    const base = context({ preferSpecificExistingModelTerms: true });
    const input: ExportContext = {
      ...base,
      existingExternalId: "321",
      existingTargetSnapshot: { product: { taxonomies: {
        pa_model: [{ term_id: 15500, name: "Asics GEL-Kayano", slug: "asics-gel-kayano" }],
      } } },
      product: {
        ...base.product,
        referenceCandidates: [{
          key: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product",
          sourceValue: "ASICS Gel Kayano 14 'White Midnight'", context: { brand: "ASICS", family: "Gel Kayano 14" }, evidence: {},
        }],
        classification: { ...base.product.classification!, resolved: [
          ...base.product.classification!.resolved,
          { candidateKey: "product:model", typeCode: "model", scope: "product.model", subjectKind: "product", referenceValueId: "13", resolutionKind: "rule", resolutionId: "100", resolutionRevision: "1" },
        ] },
      },
    };
    vi.mocked(input.references.resolveReference).mockImplementation(async ({ referenceType }) => referenceType === "model"
      ? { externalValue: "17400", externalLabel: "Asics Gel Kayano 14" }
      : referenceType === "brand"
        ? { externalValue: "31", externalLabel: "ASICS" }
        : { externalValue: "41", externalLabel: "Кроссовки" });

    const payload = await buildWordPressUpsertPayload(input);

    expect(((payload.product as JsonObject).taxonomies as JsonObject).pa_model).toEqual({
      mode: "replace", term_ids: [17400],
    });
  });

  it("requires a target snapshot before preserving brands on an existing product", async () => {
    const input: ExportContext = {
      ...context({ preserveExistingBrandTerms: true }),
      existingExternalId: "321",
    };

    await expect(buildWordPressUpsertPayload(input)).rejects.toThrow("snapshot is required");
  });

  it("loads a missing target snapshot during a read-only payload preview", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { payload: JsonObject };
      return new Response(JSON.stringify({
        ok: true,
        operation: "product_upsert_lookup",
        target_id: 321,
        matched_by: "target_id",
        payload_hash: body.payload.payload_hash,
        variation_plan: [],
        resolved_content: { description_html: "<p>Существующее описание</p>", description_source: "wordpress_existing" },
        snapshot: {
          product: {
            taxonomies: {
              pa_brand: [
                { term_id: 31, name: "Nike", slug: "nike" },
                { term_id: 5490, name: "Clarks", slug: "clarks" },
              ],
            },
          },
        },
      }), { status: 200 });
    });
    const exporter = new WordPressExporter(
      { baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 },
      request,
    );

    const preview = await exporter.previewPayload({
      ...context({ preserveExistingBrandTerms: true }),
      existingExternalId: "321",
    });

    expect((preview.payload.product as JsonObject).taxonomies).toEqual({
      pa_brand: { mode: "replace", term_ids: [31, 5490] },
      product_cat: { mode: "replace", term_ids: [41] },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("reads current WordPress brands before writing their union with resolved brands", async () => {
    let writtenPayload: JsonObject | null = null;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { payload: JsonObject };
      if (String(url).includes("slds_target_import_api=upsert-lookup")) {
        return new Response(JSON.stringify({
          ok: true,
          operation: "product_upsert_lookup",
          target_id: 321,
          matched_by: "source_identity",
          payload_hash: body.payload.payload_hash,
          variation_plan: [],
          resolved_content: { description_html: "<p>Существующее описание</p>", description_source: "wordpress_existing" },
          snapshot: {
            product: {
              taxonomies: {
                pa_brand: [
                  { term_id: 31, name: "Nike", slug: "nike" },
                  { term_id: 5490, name: "Clarks", slug: "clarks" },
                ],
              },
            },
          },
        }), { status: 200 });
      }
      writtenPayload = body.payload;
      return new Response(JSON.stringify({
        ok: true,
        job: {
          job_id: 9,
          status: "done",
          payload_hash: body.payload.payload_hash,
          result: { operation: "updated", target_id: 321, matched_by: "source_identity" },
        },
      }), { status: 202 });
    });
    const exporter = new WordPressExporter(
      { baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 },
      request,
      async () => {},
    );

    await expect(exporter.export({
      ...context({ preserveExistingBrandTerms: true }),
      existingExternalId: "321",
    })).resolves.toMatchObject({ externalId: "321", operation: "updated" });

    expect(((writtenPayload!.product as JsonObject).taxonomies as JsonObject).pa_brand).toEqual({
      mode: "replace",
      term_ids: [31, 5490],
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses the primary source brand for size conversion when an additional brand is assigned", async () => {
    const base = context({
      sizeConversionCategoryTermIds: [41],
      sizeMappings: [{ sourceValue: "8", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 108 }],
    });
    const input: ExportContext = {
      ...base,
      product: {
        ...base.product,
        variants: base.product.variants.map((variant) => ({
          ...variant,
          size: { sourceValue: "41", displayValue: "41", system: "eu-numeric", audience: "men" },
        })),
      },
    };
    vi.mocked(input.references.resolveAssignments).mockResolvedValueOnce([
      { ruleId: "401", groupCode: "additional_brand_clarks", targetScope: "product.brand", externalValue: "32", externalLabel: "Clarks", mode: "add" },
    ]);
    const converter: WordPressSizeConverterLike = {
      supports: vi.fn(() => true),
      convert: vi.fn(async ({ size }) => ({ ...size, sourceValue: "8", displayValue: "8", system: "us-numeric" })),
    };

    const payload = await buildWordPressUpsertPayload(input, converter);

    expect(converter.convert).toHaveBeenCalledWith({ brandTermId: 31, categoryTermId: 41, modelTermIds: [], size: input.product.variants[0]!.size });
    expect((payload.product as JsonObject).taxonomies).toEqual({
      pa_brand: { mode: "replace", term_ids: [31, 32] },
      product_cat: { mode: "replace", term_ids: [41] },
    });
  });

  it("converts a native source size before resolving the WordPress size term", async () => {
    const base = context({
      sizeConversionCategoryTermIds: [41],
      sizeMappings: [{ sourceValue: "8", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 108 }],
    });
    const input: ExportContext = {
      ...base,
      product: {
        ...base.product,
        variants: base.product.variants.map((variant) => ({
          ...variant,
          size: { sourceValue: "41", displayValue: "41", system: "eu-numeric", audience: "men" },
        })),
      },
    };
    const converter: WordPressSizeConverterLike = {
      supports: vi.fn(() => true),
      convert: vi.fn(async ({ size }) => ({ ...size, sourceValue: "8", displayValue: "8", system: "us-numeric" })),
    };

    const payload = await buildWordPressUpsertPayload(input, converter);
    const item = ((payload.variations as JsonObject).items as readonly JsonObject[])[0]!;

    expect(converter.convert).toHaveBeenCalledWith({ brandTermId: 31, categoryTermId: 41, modelTermIds: [], size: input.product.variants[0]!.size });
    expect(item.size).toEqual({ taxonomy: "pa_razmer", term_id: 108 });
    expect(input.product.variants[0]!.size).toEqual({ sourceValue: "41", displayValue: "41", system: "eu-numeric", audience: "men" });
  });

  it("uses an explicit size-table category alias without changing the assigned product category", async () => {
    const base = context({
      sizeConversionCategoryAliasByTermId: { "25922": 75 },
      sizeMappings: [{ sourceValue: "8", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 108 }],
    });
    const input: ExportContext = {
      ...base,
      product: {
        ...base.product,
        variants: base.product.variants.map((variant) => ({
          ...variant,
          size: { sourceValue: "41", displayValue: "41", system: "eu-numeric", audience: "men" },
        })),
      },
    };
    vi.mocked(input.references.resolveAssignments).mockResolvedValueOnce([
      { ruleId: "501", groupCode: "shoe_leaf_category", targetScope: "product.category", externalValue: "25922", externalLabel: "Сабо", mode: "replace" },
    ]);
    const converter: WordPressSizeConverterLike = {
      supports: vi.fn(() => true),
      convert: vi.fn(async ({ size }) => ({ ...size, sourceValue: "8", displayValue: "8", system: "us-numeric" })),
    };

    const payload = await buildWordPressUpsertPayload(input, converter);

    expect(converter.convert).toHaveBeenCalledWith({ brandTermId: 31, categoryTermId: 75, modelTermIds: [], size: input.product.variants[0]!.size });
    expect((payload.product as JsonObject).taxonomies).toMatchObject({
      product_cat: { mode: "replace", term_ids: [25922] },
    });
  });

  it("applies an explicit target title prefix for the resolved product category", async () => {
    const input = context({ titlePrefixByCategoryTermId: { "41": "Кроссовки" } });

    const payload = await buildWordPressUpsertPayload(input);
    const targetProduct = payload.product as JsonObject;

    expect(targetProduct.title).toBe("Кроссовки Nike Test Shoe");
    expect(targetProduct.description_html).toContain("<h2>Кроссовки Nike Test Shoe</h2>");
  });

  it("renders active long and short templates from final WordPress size data", async () => {
    const input: ExportContext = {
      ...context({ titlePrefixByCategoryTermId: { "41": "Кроссовки" } }),
      contentTemplates: [
        {
          id: "201",
          field: "description",
          revision: 3,
          templateSource: "<h2>Заказать {{ product.effective_title | lower_first }} с бесплатной доставкой</h2>{{ content.story | paragraphs }}",
          profileKey: "default",
          profileName: "Основной профиль",
          managementMode: "manage",
          categoryTermIds: [],
          requiredContextPaths: [],
        },
        {
          id: "202",
          field: "short_description",
          revision: 2,
          templateSource: "{% if variants.available_sizes %}<p>Размеры: {{ variants.available_sizes | unique | numeric_sort | range:\" — \" }} {{ variants.audience | upper }} {{ variants.size_system | size_system_label }} ({{ variants.audience | audience_label }} размерная сетка бренда)</p>{% endif %}",
          profileKey: "default",
          profileName: "Основной профиль",
          managementMode: "manage",
          categoryTermIds: [],
          requiredContextPaths: [],
        },
      ],
    };

    const payload = await buildWordPressUpsertPayload(input);
    const targetProduct = payload.product as JsonObject;

    expect(targetProduct.description_html).toContain("<h2>Заказать кроссовки Nike Test Shoe с бесплатной доставкой</h2>");
    expect(targetProduct.short_description_html).toBe("<p>Размеры: 7 — 7 MEN US (Мужская размерная сетка бренда)</p>");
    expect(payload.managed_fields).toContain("short_description");
  });

  it("uses the translated source description when the source story is missing", async () => {
    const base = context({ titlePrefixByCategoryTermId: { "41": "Кроссовки" } });
    const input: ExportContext = {
      ...base,
      product: { ...base.product, translatedContent: { ...base.product.translatedContent!, story: "" }, attributes: { ...base.product.attributes, story: null } },
      contentTemplates: [{
        id: "203", field: "description", revision: 1, templateSource: "{{ content.story | paragraphs }}",
        profileKey: "shoes", profileName: "Кроссовки", managementMode: "manage", categoryTermIds: [41], requiredContextPaths: ["content.story"],
      }],
    };

    const payload = await buildWordPressUpsertPayload(input);
    const targetProduct = payload.product as JsonObject;

    expect(payload.managed_fields).toContain("description");
    expect(targetProduct.description_html).toBe("<p>Описание</p>");
  });

  it("preserves the description outside configured profile categories", async () => {
    const input: ExportContext = {
      ...context(),
      contentTemplates: [{
        id: "204", field: "description", revision: 1, templateSource: "{{ content.story | paragraphs }}",
        profileKey: "other", profileName: "Другая категория", managementMode: "manage", categoryTermIds: [999], requiredContextPaths: [],
      }],
    };

    const payload = await buildWordPressUpsertPayload(input);

    expect(payload.managed_fields).not.toContain("description");
    expect(payload.product).not.toHaveProperty("description_html");
  });

  it("blocks a create before the write when the description is preserved", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, operation: "product_upsert_lookup", product_id: 0, target_id: 0, matched_by: "created",
      payload_hash: "placeholder", variation_plan: [],
    }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, async (input, init) => {
      const requestPayload = JSON.parse(String(init?.body)) as { payload: JsonObject };
      const response = await fetchMock(input, init);
      const body = await response.json() as JsonObject;
      return new Response(JSON.stringify({ ...body, payload_hash: requestPayload.payload.payload_hash }), { status: 200 });
    });
    const input: ExportContext = {
      ...context(),
      contentTemplates: [{
        id: "205", field: "description", revision: 1, templateSource: "<p>Не используется</p>",
        profileKey: "default", profileName: "Основной профиль", managementMode: "preserve", categoryTermIds: [], requiredContextPaths: [],
      }],
    };

    await expect(exporter.export(input)).rejects.toThrow("Нельзя создать товар без управляемого описания");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("adds taxonomy terms projected from concrete classification decisions", async () => {
    const input = context();
    vi.mocked(input.references.resolveProjections).mockResolvedValue([
      { resolutionKind: "mapping", resolutionId: "22", targetScope: "product.tag", externalValue: "892", externalLabel: "Lifestyle", externalSlug: "lifestyle" },
    ]);

    const payload = await buildWordPressUpsertPayload(input);
    const targetProduct = payload.product as JsonObject;

    expect(targetProduct.taxonomies).toEqual({
      pa_brand: { mode: "replace", term_ids: [31] },
      product_cat: { mode: "replace", term_ids: [41] },
      product_tag: { mode: "replace", term_ids: [892] },
    });
    expect(input.references.resolveProjections).toHaveBeenCalledWith([
      { resolutionKind: "mapping", resolutionId: "21", referenceId: "11" },
      { resolutionKind: "mapping", resolutionId: "22", referenceId: "12" },
    ]);
  });

  it("exposes a landing tag origin only in the local payload preview", async () => {
    const input = context();
    vi.mocked(input.references.resolveProjections).mockResolvedValue([{
      resolutionKind: "reference", resolutionId: "11", targetScope: "product.tag", externalValue: "2968",
      externalLabel: "Onitsuka Tiger", externalSlug: "onitsuka-tiger",
      provenance: {
        kind: "related_target_term", relationCode: "landing",
        sourceTypeCode: "brand", sourceLabel: "Onitsuka Tiger",
      },
    }]);

    const preview = await previewWordPressUpsertPayload(input);

    expect(preview.taxonomyOrigins).toEqual([{
      taxonomy: "product_tag", termId: 2968, relationCode: "landing",
      sourceTypeCode: "brand", sourceLabel: "Onitsuka Tiger",
    }]);
    expect(preview.payload).not.toHaveProperty("taxonomyOrigins");
  });

  it("exposes the confirmed model landing tag to content templates", async () => {
    const input: ExportContext = {
      ...context(),
      contentTemplates: [{
        id: "206", field: "description", revision: 1,
        templateSource: "{% if links.model_tag_url %}<p><span class=\"slds-managed-model-tag-link\"><a href=\"{{ links.model_tag_url }}\">Заказать другие расцветки {{ links.model_tag_name }}</a></span></p>{% endif %}",
        profileKey: "default", profileName: "Основной профиль", managementMode: "manage", categoryTermIds: [], requiredContextPaths: [],
      }],
    };
    vi.mocked(input.references.resolveProjections).mockResolvedValue([{
      resolutionKind: "reference", resolutionId: "45", targetScope: "product.tag", externalValue: "4456",
      externalLabel: "Кроссовки Nike Dunk", externalSlug: "nike-dunk",
      provenance: {
        kind: "related_target_term", relationCode: "landing",
        sourceTypeCode: "model", sourceLabel: "Nike Dunk",
      },
    }]);

    const preview = await previewWordPressUpsertPayload(input);

    expect(preview.contentContext.links).toEqual({ model_tag_name: "Nike Dunk", model_tag_url: "/tags/nike-dunk/" });
    expect((preview.payload.product as JsonObject).description_html).toBe(
      '<p><span class="slds-managed-model-tag-link"><a href="/tags/nike-dunk/" rel="noopener noreferrer">Заказать другие расцветки Nike Dunk</a></span></p>',
    );
  });

  it("rejects conflicting model landing tags", async () => {
    const input = context();
    vi.mocked(input.references.resolveProjections).mockResolvedValue([
      {
        resolutionKind: "reference", resolutionId: "45", targetScope: "product.tag", externalValue: "4456",
        externalLabel: "Кроссовки Nike Dunk", externalSlug: "nike-dunk",
        provenance: { kind: "related_target_term", relationCode: "landing", sourceTypeCode: "model", sourceLabel: "Nike Dunk" },
      },
      {
        resolutionKind: "reference", resolutionId: "45", targetScope: "product.tag", externalValue: "4457",
        externalLabel: "Кроссовки Nike Dunk Low", externalSlug: "nike-dunk-low",
        provenance: { kind: "related_target_term", relationCode: "landing", sourceTypeCode: "model", sourceLabel: "Nike Dunk" },
      },
    ]);

    await expect(previewWordPressUpsertPayload(input)).rejects.toThrow("more than one landing tag");
  });

  it("does not block or clear an unresolved optional taxonomy", async () => {
    const base = context();
    const input: ExportContext = {
      ...base,
      product: {
        ...base.product,
        referenceCandidates: [{
          key: "product:material:synthetic",
          typeCode: "material",
          scope: "product.material",
          subjectKind: "product",
          sourceValue: "Synthetic",
          context: {},
          evidence: {},
        }],
        classification: {
          ...base.product.classification!,
          status: "partial",
          unresolved: [{
            candidateKey: "product:material:synthetic",
            typeCode: "material",
            scope: "product.material",
            subjectKind: "product",
            sourceValue: "Synthetic",
            reason: "mapping_missing",
          }],
        },
      },
    };

    const payload = await buildWordPressUpsertPayload(input);
    const targetProduct = payload.product as JsonObject;

    expect(targetProduct.taxonomies).toEqual({
      pa_brand: { mode: "replace", term_ids: [31] },
      product_cat: { mode: "replace", term_ids: [41] },
    });
  });

  it("still blocks an unresolved required taxonomy", async () => {
    const base = context({ requiredReferenceTypes: ["brand", "category", "material"] });
    const input: ExportContext = {
      ...base,
      product: {
        ...base.product,
        classification: { ...base.product.classification!, status: "partial" },
      },
    };

    await expect(buildWordPressUpsertPayload(input)).rejects.toThrow("Required WordPress references are missing: material");
  });

  it("queues once and waits for the completed WordPress job", async () => {
    const input = context();
    const expectedPayload = await buildWordPressUpsertPayload(input);
    const payloadHash = String(expectedPayload.payload_hash);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, job: { job_id: 9, status: "pending", payload_hash: payloadHash } }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, jobs: [{ job_id: 9, status: "done", payload_hash: payloadHash, result: { operation: "created", target_id: 321, matched_by: "created" } }] }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock, async () => {});

    await expect(exporter.export(input)).resolves.toEqual({ externalId: "321", operation: "created", metadata: { jobId: 9, payloadHash, matchedBy: "created" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-jobs");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("slds_target_import_api=jobs-status");
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ job_ids: [9], wait_ms: 100 });
  });

  it("coalesces concurrent WordPress job status reads", async () => {
    let nextJobId = 20;
    const firstContext = context();
    const secondContext = { ...context(), product: { ...context().product, title: "Second product" } };
    const firstHash = String((await buildWordPressUpsertPayload(firstContext)).payload_hash);
    const secondHash = String((await buildWordPressUpsertPayload(secondContext)).payload_hash);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const action = new URL(String(input)).searchParams.get("slds_target_import_api");
      if (action === "upsert-jobs") {
        const body = JSON.parse(String(init?.body)) as { payload: JsonObject };
        const jobId = nextJobId++;
        return new Response(JSON.stringify({ ok: true, job: { job_id: jobId, status: "pending", payload_hash: body.payload.payload_hash } }), { status: 202 });
      }
      const body = JSON.parse(String(init?.body)) as { job_ids: number[] };
      return new Response(JSON.stringify({
        ok: true,
        jobs: body.job_ids.map((jobId) => ({
          job_id: jobId,
          status: "done",
          payload_hash: jobId === 20 ? firstHash : secondHash,
          result: { operation: "updated", target_id: jobId, matched_by: "source_identity" },
        })),
      }), { status: 200 });
    });
    const exporter = new WordPressExporter(
      { baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 },
      fetchMock,
      async () => {},
    );

    await expect(Promise.all([exporter.export(firstContext), exporter.export(secondContext)])).resolves.toHaveLength(2);

    const statusCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("slds_target_import_api=jobs-status"));
    expect(statusCalls).toHaveLength(1);
    expect(JSON.parse(String((statusCalls[0]?.[1] as RequestInit).body))).toEqual({ job_ids: [20, 21], wait_ms: 100 });
  });

  it("maps a WordPress no-op result to a skipped export", async () => {
    const input = context();
    const expectedPayload = await buildWordPressUpsertPayload(input);
    const payloadHash = String(expectedPayload.payload_hash);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      job: {
        job_id: 10,
        status: "done",
        payload_hash: payloadHash,
        result: { operation: "unchanged", target_id: 321, matched_by: "source_identity" },
      },
    }), { status: 202 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.export(input)).resolves.toMatchObject({ externalId: "321", operation: "skipped" });
  });

  it("blocks an approved export before WordPress when the payload changed", async () => {
    const fetchMock = vi.fn();
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);
    const input: ExportContext = {
      ...context(),
      approval: { payloadHash: "0".repeat(64), willCreate: false, externalId: "321", matchedBy: "source_identity" },
    };

    await expect(exporter.export(input)).rejects.toThrow("payload изменился");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts live commerce changes after approval and writes them immediately", async () => {
    const base: ExportContext = { ...context(), existingExternalId: "321" };
    const approvedPayload = await buildWordPressUpsertPayload(base);
    const liveVariants = base.product.variants.map((variant) => ({
      ...variant,
      price: { amount: "2693.00", currency: "USD" },
      inventory: { availability: "available" as const, quantity: 1 },
    }));
    const liveContext: ExportContext = { ...base, liveVariants };
    const livePayload = await buildWordPressUpsertPayload(liveContext);
    const livePayloadHash = String(livePayload.payload_hash);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        operation: "product_upsert_lookup",
        target_id: 321,
        matched_by: "source_identity",
        payload_hash: livePayloadHash,
        variation_plan: [],
        resolved_content: { description_html: "<p>Существующее описание</p>", description_source: "wordpress_existing" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        job: {
          job_id: 9,
          status: "done",
          payload_hash: livePayloadHash,
          result: { operation: "updated", target_id: 321, matched_by: "source_identity" },
        },
      }), { status: 202 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.export({
      ...liveContext,
      approval: {
        payloadHash: String(approvedPayload.payload_hash),
        willCreate: false,
        externalId: "321",
        matchedBy: "source_identity",
      },
    })).resolves.toMatchObject({ externalId: "321", operation: "updated" });

    const writeBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as { payload: JsonObject };
    const variations = writeBody.payload.variations as JsonObject;
    expect((variations.items as readonly JsonObject[])[0]?.price).toEqual({ source_currency: "USD", source_minor_amount: "269300" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still rejects a static product change when live variants are present", async () => {
    const base: ExportContext = { ...context(), existingExternalId: "321" };
    const approvedPayload = await buildWordPressUpsertPayload(base);
    const fetchMock = vi.fn();
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.export({
      ...base,
      product: { ...base.product, title: "Changed after approval" },
      liveVariants: base.product.variants,
      approval: {
        payloadHash: String(approvedPayload.payload_hash),
        willCreate: false,
        externalId: "321",
        matchedBy: "source_identity",
      },
    })).rejects.toThrow("payload изменился");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks WordPress identity immediately before an approved write", async () => {
    const base = context();
    const payload = await buildWordPressUpsertPayload(base);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      operation: "product_upsert_lookup",
      product_id: 322,
      target_id: 322,
      matched_by: "source_identity",
      payload_hash: payload.payload_hash,
      variation_plan: [],
      resolved_content: { description_html: "<p>Существующее описание</p>", description_source: "wordpress_existing" },
    }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);
    const input: ExportContext = {
      ...base,
      approval: { payloadHash: String(payload.payload_hash), willCreate: false, externalId: "321", matchedBy: "source_identity" },
    };

    await expect(exporter.export(input)).rejects.toThrow("Состояние товара WordPress изменилось");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-lookup");
  });

  it("blocks an approved write when the WordPress snapshot changed", async () => {
    const base = context();
    const payload = await buildWordPressUpsertPayload(base);
    const currentSnapshot = { product: { target_id: 321, title: "Изменено вручную" } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      operation: "product_upsert_lookup",
      target_id: 321,
      matched_by: "source_identity",
      payload_hash: payload.payload_hash,
      variation_plan: [],
      snapshot: currentSnapshot,
      resolved_content: { description_html: "<p>Существующее описание</p>", description_source: "wordpress_existing" },
    }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.export({
      ...base,
      approval: {
        payloadHash: String(payload.payload_hash),
        willCreate: false,
        externalId: "321",
        matchedBy: "source_identity",
        wordpressStateHash: hashStableJson({ externalId: "321", snapshot: { product: { target_id: 321, title: "До изменения" } } }),
      },
    })).rejects.toThrow("Товар WordPress изменился");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses an approved saved snapshot as the WordPress write precondition without a second lookup", async () => {
    const savedSnapshot = { product: { target_id: 321, title: "До изменения", taxonomies: {} } };
    const base: ExportContext = { ...context(), existingExternalId: "321", existingTargetSnapshot: savedSnapshot };
    const payload = await buildWordPressUpsertPayload(base);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      job: {
        job_id: 91,
        status: "done",
        payload_hash: payload.payload_hash,
        result: { operation: "updated", target_id: 321, matched_by: "target_id+source_identity" },
      },
    }), { status: 202 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.export({
      ...base,
      approval: {
        payloadHash: String(payload.payload_hash),
        willCreate: false,
        externalId: "321",
        matchedBy: "source_identity",
        wordpressStateHash: hashStableJson({ externalId: "321", snapshot: savedSnapshot }),
      },
    })).resolves.toMatchObject({ externalId: "321", operation: "updated" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-jobs");
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.patch).toEqual({ expected_target_snapshot: savedSnapshot });
  });

  it("preflights an upsert payload without creating a job", async () => {
    const input = context();
    const payload = await buildWordPressUpsertPayload(input);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      operation: "product_upsert_lookup",
      product_id: 321,
      target_id: 321,
      matched_by: "legacy_sku",
      payload_hash: payload.payload_hash,
      snapshot: { product: { target_id: 321, sku: "SKU-1" } },
      variation_plan: [{
        variation_id: 123,
        source_variant_key: "offer-7",
        size: { taxonomy: "pa_razmer", term_id: 107 },
        regular_price: "12345",
        stock_status: "instock",
        manage_stock: false,
        stock_quantity: null,
      }],
      resolved_content: { description_html: "<p>Существующее описание</p>", description_source: "wordpress_existing" },
    }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.preflightPayload(payload)).resolves.toEqual({
      externalId: "321",
      willCreate: false,
      matchedBy: "legacy_sku",
      payloadHash: payload.payload_hash,
      snapshot: { product: { target_id: 321, sku: "SKU-1" } },
      variationPlan: [{
        variation_id: 123,
        source_variant_key: "offer-7",
        size: { taxonomy: "pa_razmer", term_id: 107 },
        regular_price: "12345",
        stock_status: "instock",
        manage_stock: false,
        stock_quantity: null,
      }],
      resolvedDescriptionHtml: "<p>Существующее описание</p>",
      resolvedDescriptionSource: "wordpress_existing",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-lookup");
  });

  it("reads the preferred description resolved by WordPress preflight", async () => {
    const base = context();
    const input: ExportContext = {
      ...base,
      product: { ...base.product, translatedContent: { ...base.product.translatedContent!, story: "" } },
      contentTemplates: [{
        id: "301", field: "description", revision: 1,
        templateSource: "<h2>{{ product.effective_title }}</h2>{{ content.story | paragraphs }}<ul><li>Артикул: {{ product.sku }}</li></ul>",
        profileKey: "default", profileName: "Основной профиль", managementMode: "manage", categoryTermIds: [],
        requiredContextPaths: [],
      }],
    };
    const payload = await buildWordPressUpsertPayload(input);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, target_id: 321, matched_by: "source_identity", payload_hash: payload.payload_hash, variation_plan: [],
      resolved_content: { description_html: "<p>Существующее описание</p>", description_source: "wordpress_existing" },
    }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.preflightPayload(payload)).resolves.toMatchObject({
      resolvedDescriptionHtml: "<p>Существующее описание</p>",
      resolvedDescriptionSource: "wordpress_existing",
    });
  });

  it("represents a new product preflight without an external ID", async () => {
    const payload = await buildWordPressUpsertPayload(context());
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      operation: "product_upsert_lookup",
      product_id: 0,
      target_id: 0,
      matched_by: "created",
      payload_hash: payload.payload_hash,
      variation_plan: [],
      resolved_content: { description_html: String((payload.product as JsonObject).description_html ?? ""), description_source: "source_story" },
    }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.preflightPayload(payload)).resolves.toEqual({
      externalId: null,
      willCreate: true,
      matchedBy: "created",
      payloadHash: payload.payload_hash,
      variationPlan: [],
      resolvedDescriptionHtml: String((payload.product as JsonObject).description_html ?? ""),
      resolvedDescriptionSource: "source_story",
    });
  });

  it("stops before the request when a target size mapping is missing", async () => {
    const fetchMock = vi.fn();
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.export(context({ sizeMappings: [{ sourceValue: "8", taxonomy: "pa_razmer", termId: 109 }] }))).rejects.toBeInstanceOf(IntegrationContractError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("temporarily omits unmapped size variants when the target policy explicitly allows it", async () => {
    const base = context({ ignoreUnmappedSizeVariants: true });
    const input: ExportContext = {
      ...base,
      product: {
        ...base.product,
        variants: [
          ...base.product.variants,
          {
            sourceVariantKey: "offer-12.5",
            sku: "ROOT-SKU-12.5",
            size: { sourceValue: "12.5", displayValue: "12.5", system: "us-numeric", audience: "youth" },
            price: { amount: "2463.00", currency: "USD" },
            inventory: { availability: "available" },
            attributes: {},
          },
        ],
      },
    };

    const preview = await previewWordPressUpsertPayload(input);
    const variations = preview.payload.variations as JsonObject;

    expect(variations.items).toHaveLength(1);
    expect(preview.ignoredSizeVariants).toEqual([expect.objectContaining({
      sourceVariantKey: "offer-12.5",
      sourceValue: "12.5",
      audience: "youth",
      price: { amount: "2463.00", currency: "USD" },
      reason: "WordPress size mapping is missing: us-numeric/youth/12.5/12.5",
    })]);
  });

  it("still blocks when every source variant has an unmapped size", async () => {
    const base = context({
      ignoreUnmappedSizeVariants: true,
      sizeMappings: [{ sourceValue: "8", system: "us-numeric", audience: "men", taxonomy: "pa_razmer", termId: 108 }],
    });

    await expect(buildWordPressUpsertPayload(base)).rejects.toThrow("WordPress export has no variants with mapped sizes");
  });

  it("blocks products without images before any WordPress request", async () => {
    const fetchMock = vi.fn();
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);
    const base = context();

    await expect(exporter.export({ ...base, product: { ...base.product, images: [] } }))
      .rejects.toThrow("WordPress export requires at least one processed product image");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates an explicit zero-stock shell for a new product without source variants", async () => {
    const base = context();
    const payload = await buildWordPressUpsertPayload({
      ...base,
      product: { ...base.product, variants: [] },
    });

    expect(payload.variations).toEqual({ mode: "replace_active_set", missing_policy: "out_of_stock", items: [] });
    expect(payload.creation_policy).toEqual({
      allow_empty_variations: true,
      stock_status: "outofstock",
      stock_quantity: 0,
    });
  });

  it("uses an empty active set to mark an existing product sold out", async () => {
    const base = context();
    const payload = await buildWordPressUpsertPayload({
      ...base,
      existingExternalId: "321",
      liveVariants: [],
    });

    expect(payload.variations).toEqual({ mode: "replace_active_set", missing_policy: "out_of_stock", items: [] });
  });

  it("builds a sold-out variation patch without requiring size mappings", async () => {
    const base = context({ sizeMappings: [] });
    const draft = await previewWordPressVariationPatchItems({ ...base, existingExternalId: "321", liveVariants: [] });

    expect(draft).toEqual({ items: [], sourceTargetSizes: [], knownTargetSizes: [], ignored: [], deactivateAll: true });
  });

  it("sends an explicit null price for an unavailable variation", async () => {
    const base = context();
    const input: ExportContext = {
      ...base,
      product: {
        ...base.product,
        variants: base.product.variants.map((variant) => ({
          ...variant,
          price: null,
          inventory: { availability: "unavailable" },
        })),
      },
    };

    const payload = await buildWordPressUpsertPayload(input);
    const variations = payload.variations as JsonObject;
    const item = (variations.items as readonly JsonObject[])[0]!;

    expect(item.price).toBeNull();
  });

  it("treats an invalid proxy response for a retryable HTTP status as retryable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html>upstream unavailable</html>", { status: 503 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.export(context())).rejects.toBeInstanceOf(RetryableError);
  });
});
