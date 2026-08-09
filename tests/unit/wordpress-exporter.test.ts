import { describe, expect, it, vi } from "vitest";

import type { ExportContext, JsonObject, UniversalProductDTO } from "../../src/contracts/index.js";
import { IntegrationContractError, RetryableError } from "../../src/core/errors/index.js";
import { buildWordPressUpsertPayload, WordPressExporter, type WordPressSizeConverterLike } from "../../src/integrations/index.js";

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
  translatedContent: { sourceLocale: "en", targetLocale: "ru", description: "Описание", story: "История", color: "Черный", details: "Black", upperMaterial: "Кожа" },
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
      resolveReference: vi.fn(async ({ referenceType }) => referenceType === "brand" ? "31" : "41"),
      resolveProjections: vi.fn().mockResolvedValue([]),
    },
  };
}

describe("WordPressExporter", () => {
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
    expect(payload.managed_fields).not.toContain("short_description");
    expect(targetProduct).not.toHaveProperty("short_description_html");
    expect(item).toMatchObject({ variation_key: "goat:100|offer-7", sku: "ROOT-SKU-7", size: { taxonomy: "pa_razmer", term_id: 107 }, price: { source_currency: "USD", source_minor_amount: "12345" }, inventory: { availability: "available" } });
    expect((item.inventory as JsonObject).quantity).toBeUndefined();
    expect(String(payload.idempotency_key)).toMatch(/^product-upsert:[a-f0-9]{64}$/u);
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

    expect(converter.convert).toHaveBeenCalledWith({ brandTermId: 31, categoryTermId: 41, size: input.product.variants[0]!.size });
    expect(item.size).toEqual({ taxonomy: "pa_razmer", term_id: 108 });
    expect(input.product.variants[0]!.size).toEqual({ sourceValue: "41", displayValue: "41", system: "eu-numeric", audience: "men" });
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
        },
        {
          id: "202",
          field: "short_description",
          revision: 2,
          templateSource: "{% if variants.available_sizes %}<p>Размеры: {{ variants.available_sizes | unique | numeric_sort | range:\" — \" }} {{ variants.audience | upper }} {{ variants.size_system | size_system_label }} ({{ variants.audience | audience_label }} размерная сетка бренда)</p>{% endif %}",
        },
      ],
    };

    const payload = await buildWordPressUpsertPayload(input);
    const targetProduct = payload.product as JsonObject;

    expect(targetProduct.description_html).toContain("<h2>Заказать кроссовки Nike Test Shoe с бесплатной доставкой</h2>");
    expect(targetProduct.short_description_html).toBe("<p>Размеры: 7 — 7 MEN US (Мужская размерная сетка бренда)</p>");
    expect(payload.managed_fields).toContain("short_description");
  });

  it("adds taxonomy terms projected from concrete classification decisions", async () => {
    const input = context();
    vi.mocked(input.references.resolveProjections).mockResolvedValue([
      { resolutionKind: "mapping", resolutionId: "22", targetScope: "product.tag", externalValue: "892" },
    ]);

    const payload = await buildWordPressUpsertPayload(input);
    const targetProduct = payload.product as JsonObject;

    expect(targetProduct.taxonomies).toEqual({
      pa_brand: { mode: "replace", term_ids: [31] },
      product_cat: { mode: "replace", term_ids: [41] },
      product_tag: { mode: "replace", term_ids: [892] },
    });
    expect(input.references.resolveProjections).toHaveBeenCalledWith([
      { resolutionKind: "mapping", resolutionId: "21" },
      { resolutionKind: "mapping", resolutionId: "22" },
    ]);
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, job: { job_id: 9, status: "done", payload_hash: payloadHash, result: { operation: "created", target_id: 321, matched_by: "created" } } }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock, async () => {});

    await expect(exporter.export(input)).resolves.toEqual({ externalId: "321", operation: "created", metadata: { jobId: 9, payloadHash, matchedBy: "created" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-jobs");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("slds_target_import_api=job&id=9");
  });

  it("preflights an upsert payload without creating a job", async () => {
    const input = context();
    const payload = await buildWordPressUpsertPayload(input);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      operation: "product_upsert_lookup",
      product_id: 321,
      target_id: 321,
      matched_by: "legacy_goat_id",
      payload_hash: payload.payload_hash,
      variation_plan: [{
        variation_id: 123,
        source_variant_key: "offer-7",
        size: { taxonomy: "pa_razmer", term_id: 107 },
        regular_price: "12345",
        stock_status: "instock",
        manage_stock: false,
        stock_quantity: null,
      }],
    }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.preflightPayload(payload)).resolves.toEqual({
      externalId: "321",
      willCreate: false,
      matchedBy: "legacy_goat_id",
      payloadHash: payload.payload_hash,
      variationPlan: [{
        variation_id: 123,
        source_variant_key: "offer-7",
        size: { taxonomy: "pa_razmer", term_id: 107 },
        regular_price: "12345",
        stock_status: "instock",
        manage_stock: false,
        stock_quantity: null,
      }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-lookup");
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
    }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.preflightPayload(payload)).resolves.toEqual({
      externalId: null,
      willCreate: true,
      matchedBy: "created",
      payloadHash: payload.payload_hash,
      variationPlan: [],
    });
  });

  it("stops before the request when a target size mapping is missing", async () => {
    const fetchMock = vi.fn();
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.export(context({ sizeMappings: [{ sourceValue: "8", taxonomy: "pa_razmer", termId: 109 }] }))).rejects.toBeInstanceOf(IntegrationContractError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks products without images or variants before any WordPress request", async () => {
    const fetchMock = vi.fn();
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);
    const base = context();

    await expect(exporter.export({ ...base, product: { ...base.product, images: [] } }))
      .rejects.toThrow("WordPress export requires at least one processed product image");
    await expect(exporter.export({ ...base, product: { ...base.product, variants: [] } }))
      .rejects.toThrow("WordPress export requires product variants until the sold-out contract is configured");
    expect(fetchMock).not.toHaveBeenCalled();
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
