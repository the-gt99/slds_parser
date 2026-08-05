import { describe, expect, it, vi } from "vitest";

import type { ExportContext, JsonObject, UniversalProductDTO } from "../../src/contracts/index.js";
import { IntegrationContractError, RetryableError } from "../../src/core/errors/index.js";
import { buildWordPressUpsertPayload, WordPressExporter } from "../../src/integrations/index.js";

const product: UniversalProductDTO = {
  sourceProductId: "2",
  title: "Nike Test Shoe",
  description: "Source description",
  sku: "ROOT-SKU",
  images: [{ url: "https://parser.example/images/test-1.webp", sourceUrl: "https://source.example/test.png", position: 0, alt: "Test", attributes: {} }],
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
    expect(targetProduct.images).toEqual([{ url: "https://parser.example/images/test-1.webp", filename: "test-1.webp", source_url: "https://source.example/test.png" }]);
    expect(targetProduct.description_html).toContain("<li>Технология: Air</li>");
    expect(targetProduct.description_html).toContain("<li>Категория: sneakers</li>");
    expect(targetProduct.description_html).toContain("<li>Дата релиза: 02 января 2026г.</li>");
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

  it("stops before the request when a target size mapping is missing", async () => {
    const fetchMock = vi.fn();
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.export(context({ sizeMappings: [{ sourceValue: "8", taxonomy: "pa_razmer", termId: 109 }] }))).rejects.toBeInstanceOf(IntegrationContractError);
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
