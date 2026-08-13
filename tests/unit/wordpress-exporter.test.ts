import { describe, expect, it, vi } from "vitest";

import type { ExportContext, JsonObject, UniversalProductDTO } from "../../src/contracts/index.js";
import { IntegrationContractError, RetryableError } from "../../src/core/errors/index.js";
import { hashStableJson } from "../../src/core/utils/index.js";
import { buildWordPressUpsertPayload, previewWordPressUpsertPayload, WordPressExporter, type WordPressSizeConverterLike } from "../../src/integrations/index.js";

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
      resolveAssignments: vi.fn().mockResolvedValue([]),
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

  it("delegates an empty GOAT story to the existing WordPress description", async () => {
    const base = context();
    const input: ExportContext = {
      ...base,
      product: { ...base.product, translatedContent: { ...base.product.translatedContent!, story: "" } },
      contentTemplates: [{
        id: "300", field: "description", revision: 1,
        templateSource: "<h2>{{ product.effective_title }}</h2>{% if content.story %}{{ content.story | paragraphs }}{% endif %}<ul><li>Артикул: {{ product.sku }}</li></ul>",
        profileKey: "default", profileName: "Основной профиль", managementMode: "manage", categoryTermIds: [],
        requiredContextPaths: ["content.story"], preserveExistingStory: true,
      }],
    };

    const payload = await buildWordPressUpsertPayload(input);
    expect((payload.product as JsonObject).description_html).toContain("slds-existing-story-placeholder");
    expect(payload.content_policy).toEqual({ description_story: { mode: "preserve_existing", required: true } });
  });

  it("applies the winning target assignment after direct category mappings", async () => {
    const input = context();
    vi.mocked(input.references.resolveAssignments).mockResolvedValueOnce([
      { ruleId: "300", groupCode: "sandal_leaf", targetScope: "product.category", externalValue: "900", mode: "replace" },
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
      { ruleId: "301", groupCode: "seasonal_category", targetScope: "product.category", externalValue: "901", mode: "add" },
      { ruleId: "300", groupCode: "sandal_leaf", targetScope: "product.category", externalValue: "900", mode: "replace" },
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
      if (referenceType === "brand") return "31";
      if (referenceType === "model") return "51";
      return "41";
    });
    vi.mocked(input.references.resolveAssignments).mockResolvedValueOnce([
      { ruleId: "401", groupCode: "additional_brand_clarks", targetScope: "product.brand", externalValue: "32", mode: "add" },
      { ruleId: "402", groupCode: "additional_model_8th_street", targetScope: "product.model", externalValue: "52", mode: "add" },
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

  it("requires a target snapshot before preserving brands on an existing product", async () => {
    const input: ExportContext = {
      ...context({ preserveExistingBrandTerms: true }),
      existingExternalId: "321",
    };

    await expect(buildWordPressUpsertPayload(input)).rejects.toThrow("snapshot is required");
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
      { ruleId: "401", groupCode: "additional_brand_clarks", targetScope: "product.brand", externalValue: "32", mode: "add" },
    ]);
    const converter: WordPressSizeConverterLike = {
      supports: vi.fn(() => true),
      convert: vi.fn(async ({ size }) => ({ ...size, sourceValue: "8", displayValue: "8", system: "us-numeric" })),
    };

    const payload = await buildWordPressUpsertPayload(input, converter);

    expect(converter.convert).toHaveBeenCalledWith({ brandTermId: 31, categoryTermId: 41, size: input.product.variants[0]!.size });
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

  it("preserves an existing description when the profile requires a missing story", async () => {
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

    expect(payload.managed_fields).not.toContain("description");
    expect(targetProduct).not.toHaveProperty("description_html");
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, job: { job_id: 9, status: "done", payload_hash: payloadHash, result: { operation: "created", target_id: 321, matched_by: "created" } } }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock, async () => {});

    await expect(exporter.export(input)).resolves.toEqual({ externalId: "321", operation: "created", metadata: { jobId: 9, payloadHash, matchedBy: "created" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-jobs");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("slds_target_import_api=job&id=9");
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
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-lookup");
  });

  it("reads the description resolved by WordPress preflight", async () => {
    const base = context();
    const input: ExportContext = {
      ...base,
      product: { ...base.product, translatedContent: { ...base.product.translatedContent!, story: "" } },
      contentTemplates: [{
        id: "301", field: "description", revision: 1,
        templateSource: "<h2>{{ product.effective_title }}</h2>{{ content.story | paragraphs }}<ul><li>Артикул: {{ product.sku }}</li></ul>",
        profileKey: "default", profileName: "Основной профиль", managementMode: "manage", categoryTermIds: [],
        requiredContextPaths: [], preserveExistingStory: true,
      }],
    };
    const payload = await buildWordPressUpsertPayload(input);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, target_id: 321, matched_by: "source_identity", payload_hash: payload.payload_hash, variation_plan: [],
      resolved_content: { description_html: "<h2>Новое</h2><p>Старая история</p><ul><li>Артикул: ROOT-SKU</li></ul>", story_source: "wordpress_existing" },
    }), { status: 200 }));
    const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, fetchMock);

    await expect(exporter.preflightPayload(payload)).resolves.toMatchObject({
      resolvedDescriptionHtml: "<h2>Новое</h2><p>Старая история</p><ul><li>Артикул: ROOT-SKU</li></ul>",
      resolvedStorySource: "wordpress_existing",
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
