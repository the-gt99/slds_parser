import { describe, expect, it } from "vitest";

import { buildWordPressCatalogAudit } from "../../src/services/wordpress-catalog-audit.js";

describe("buildWordPressCatalogAudit", () => {
  it("keeps a reproducible local before/after diff including terms, images and variation state", () => {
    const result = buildWordPressCatalogAudit({
      payload: {
        managed_fields: ["title", "description"],
        product: {
          title: "Новое название",
          description_html: "<p>Новое описание</p>",
          taxonomies: { pa_brand: { term_ids: [12] }, product_tag: { term_ids: [21] } },
          images: [{ source_url: "https://images.example/new.webp", content_hash: "new" }],
        },
        variations: { items: [{
          source_variant_key: "offer-1",
          size: { taxonomy: "pa_razmer", term_id: 101 },
          price: { source_currency: "USD", source_minor_amount: "12300" },
          inventory: { availability: "unavailable", quantity: 0 },
        }] },
      },
      ignoredSizeVariants: [],
    } as never, {
      product: {
        title: "Старое название",
        description_html: "<p>Старое описание</p>",
        taxonomies: {
          pa_brand: [{ term_id: 11, name: "Старый бренд" }],
          product_tag: [{ term_id: 21, name: "Тег" }],
        },
        images: [{ url: "https://images.example/old.webp", content_hash: "old" }],
        variations: [{
          variation_id: 500,
          regular_price: "10000",
          stock_status: "instock",
          stock_quantity: null,
          attributes: [{ taxonomy: "pa_razmer", term_id: 101 }],
        }],
      },
    });

    expect(result.risk).toBe("danger");
    expect(result.fields).toContainEqual(expect.objectContaining({ field: "title", before: "Старое название", after: "Новое название", changed: true }));
    expect(result.taxonomies).toContainEqual(expect.objectContaining({
      taxonomy: "pa_brand", added: [12], removed: [11], before_terms: [{ term_id: 11, name: "Старый бренд" }],
    }));
    expect(result.images).toEqual(expect.objectContaining({
      changed: true,
      before_items: [{ key: "old", url: "https://images.example/old.webp" }],
      after_items: [{ key: "new", url: "https://images.example/new.webp" }],
    }));
    expect(result.variations).toEqual(expect.objectContaining({
      items: [expect.objectContaining({ size: "pa_razmer:101", price_managed: true, stock_changed: true })],
    }));
  });
});
