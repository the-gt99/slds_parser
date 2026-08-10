import { afterEach, describe, expect, it, vi } from "vitest";

import { WordPressDictionaryProvider } from "../../src/integrations/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("WordPressDictionaryProvider", () => {
  it("declares the target taxonomies used by classification", () => {
    const provider = new WordPressDictionaryProvider({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 });

    expect(provider.supportedEntityTypes).toEqual(expect.arrayContaining([
      "brands", "models", "tags", "product_categories", "colors", "materials", "seasons", "activities",
    ]));
    expect(provider.classificationCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ typeCode: "color", entityType: "colors", cardinality: "single" }),
      expect.objectContaining({ typeCode: "category", entityType: "product_categories", cardinality: "multiple" }),
      expect.objectContaining({ typeCode: "merchandising_category", entityType: "tags", targetScope: "product.tag", cardinality: "multiple" }),
      expect.objectContaining({ typeCode: "material", entityType: "materials", cardinality: "multiple" }),
      expect.objectContaining({ typeCode: "activity", entityType: "activities", cardinality: "multiple" }),
    ]));
    expect(provider.productEditUrl("123")).toBe("https://shop.example/wp-admin/post.php?post=123&action=edit");
  });

  it("reads and normalizes the confirmed WordPress dictionary contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      items: [{
        entity_type: "brands", target_id: 17, name: "Nike", slug: "nike",
        parent_target_id: 0, taxonomy: "pa_brand", attribute_code: "brand",
        updated_at: null, sync_cursor: "pa_brand:17", raw_meta: { tag_id: 3 },
      }],
      has_more: false,
      next_page: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new WordPressDictionaryProvider({
      baseUrl: "https://shop.example",
      authToken: "secret-token",
      timeoutMs: 5_000,
      jobTimeoutMs: 10_000,
      pollIntervalMs: 100,
    });

    const page = await provider.fetchPage("brands", 1, 200);

    expect(page.values[0]).toEqual({
      externalId: "17",
      name: "Nike",
      slug: "nike",
      parentExternalId: null,
      taxonomy: "pa_brand",
      attributeCode: "brand",
      remoteUpdatedAt: null,
      syncCursor: "pa_brand:17",
      metadata: { entityType: "brands", rawMeta: { tag_id: 3 } },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("slds_target_import_api=dictionaries");
    expect((init.headers as Record<string, string>)["X-SLDS-Import-Token"]).toBe("secret-token");
  });

  it("uses the legacy create-term fields without exposing them to the classifier core", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      term: { target_id: 91, name: "Pegasus Trail", slug: "pegasus-trail", taxonomy: "pa_model" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new WordPressDictionaryProvider({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 });

    await provider.createTerm({
      entityType: "models",
      name: "Pegasus Trail",
      sourceValue: "Nike ACG Pegasus Trail",
      sourceCode: "goat",
      requestReference: "55",
      slug: "nike-acg-pegasus-trail",
      parentExternalId: "12",
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload).toEqual({
      entity_type: "models",
      name: "Pegasus Trail",
      source_value: "Nike ACG Pegasus Trail",
      donor_id: "goat",
      mapping_id: "55",
      slug: "nike-acg-pegasus-trail",
      parent_target_id: "12",
    });
  });
});
