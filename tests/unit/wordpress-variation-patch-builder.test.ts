import { describe, expect, it } from "vitest";

import { hasAvailableWordPressVariation, matchExistingWordPressVariations } from "../../src/integrations/wordpress/index.js";

describe("hasAvailableWordPressVariation", () => {
  it("does not treat archived stock as an available offer", () => {
    expect(hasAvailableWordPressVariation({ product: { variations: [
      { variation_id: 500, status: "publish", stock_status: "outofstock" },
      { variation_id: 501, status: "draft", stock_status: "instock" },
    ] } })).toBe(false);
  });
  it("detects target stock drift after GOAT became sold out", () => {
    expect(hasAvailableWordPressVariation({ product: { variations: [
      { variation_id: 500, stock_status: "outofstock" },
      { variation_id: 501, stock_status: "instock" },
    ] } })).toBe(true);
    expect(hasAvailableWordPressVariation({ product: { variations: [
      { variation_id: 500, stock_status: "outofstock" },
      { variation_id: 501, stock_status: "outofstock" },
    ] } })).toBe(false);
  });
});

describe("matchExistingWordPressVariations", () => {
  it("ignores archived duplicates for updates and sold-out patches", () => {
    const snapshot = { product: { variations: [
      { variation_id: 500, status: "publish", attributes: [{ taxonomy: "pa_razmer", term_id: 10 }] },
      { variation_id: 501, status: "draft", attributes: [{ taxonomy: "pa_razmer", term_id: 10 }] },
      { variation_id: 502, status: "private", attributes: [{ taxonomy: "pa_razmer", term_id: 11 }] },
    ] } };
    const draft = {
      items: [{ size: { taxonomy: "pa_razmer", term_id: 10 }, inventory: { availability: "available" } }],
      sourceTargetSizes: ["pa_razmer:10"], knownTargetSizes: ["pa_razmer:10", "pa_razmer:11"],
      ignored: [], deactivateAll: false,
    };
    expect(matchExistingWordPressVariations(draft, snapshot).items.map((item) => item.variation_id)).toEqual([500, 502]);
    expect(matchExistingWordPressVariations({ ...draft, deactivateAll: true }, snapshot).items.map((item) => item.variation_id)).toEqual([500, 502]);
  });
  it("updates exact existing sizes and creates an available absent size", () => {
    const result = matchExistingWordPressVariations({
      items: [
        { source_variant_key: "a", size: { taxonomy: "pa_razmer", term_id: 10 }, price: { source_currency: "USD", source_minor_amount: "10000" }, inventory: { availability: "available" } },
        { variation_key: "goat:product|pa_razmer:11", source_variant_key: "b", size: { taxonomy: "pa_razmer", term_id: 11 }, price: { source_currency: "USD", source_minor_amount: "12000" }, inventory: { availability: "available" } },
      ],
      sourceTargetSizes: ["pa_razmer:10", "pa_razmer:11"],
      knownTargetSizes: ["pa_razmer:10", "pa_razmer:11"],
      ignored: [],
      deactivateAll: false,
    }, { product: { variations: [{ variation_id: 500, attributes: [{ taxonomy: "pa_razmer", term_id: 10 }] }] } });
    expect(result.items).toEqual([
      expect.objectContaining({ variation_id: 500, size: { taxonomy: "pa_razmer", term_id: 10 } }),
      {
        variation_key: "goat:product|pa_razmer:11",
        source_variant_key: "b",
        size: { taxonomy: "pa_razmer", term_id: 11 },
        price: { source_currency: "USD", source_minor_amount: "12000" },
        inventory: { availability: "available" },
      },
    ]);
    expect(result.ignored).toEqual([]);
  });

  it("does not create an absent size without an available priced offer", () => {
    const result = matchExistingWordPressVariations({
      items: [{
        variation_key: "goat:product|pa_razmer:11",
        source_variant_key: "b",
        size: { taxonomy: "pa_razmer", term_id: 11 },
        price: null,
        inventory: { availability: "unavailable", quantity: 0 },
      }],
      sourceTargetSizes: ["pa_razmer:11"],
      knownTargetSizes: ["pa_razmer:11"],
      ignored: [],
      deactivateAll: false,
    }, { product: { variations: [] } });

    expect(result.items).toEqual([]);
    expect(result.ignored).toEqual([expect.objectContaining({ sourceVariantKey: "b", reason: expect.stringContaining("только для доступного") })]);
  });

  it("blocks duplicate existing variations for one size", () => {
    expect(() => matchExistingWordPressVariations({
      items: [{ source_variant_key: "a", size: { taxonomy: "pa_razmer", term_id: 10 }, inventory: { availability: "available" } }],
      sourceTargetSizes: ["pa_razmer:10"],
      knownTargetSizes: ["pa_razmer:10"],
      ignored: [],
      deactivateAll: false,
    }, { product: { variations: [
      { variation_id: 500, attributes: [{ taxonomy: "pa_razmer", term_id: 10 }] },
      { variation_id: 501, attributes: [{ taxonomy: "pa_razmer", term_id: 10 }] },
    ] } })).toThrow("more than one variation");
  });

  it("marks a known existing size unavailable when a complete live set no longer contains it", () => {
    const result = matchExistingWordPressVariations({
      items: [{ source_variant_key: "a", size: { taxonomy: "pa_razmer", term_id: 10 }, inventory: { availability: "available" } }],
      sourceTargetSizes: ["pa_razmer:10"],
      knownTargetSizes: ["pa_razmer:10", "pa_razmer:11"],
      ignored: [],
      deactivateAll: false,
    }, { product: { variations: [
      { variation_id: 500, attributes: [{ taxonomy: "pa_razmer", term_id: 10 }] },
      { variation_id: 501, attributes: [{ taxonomy: "pa_razmer", term_id: 11 }] },
    ] } });
    expect(result.items).toContainEqual({ variation_id: 501, size: { taxonomy: "pa_razmer", term_id: 11 }, inventory: { availability: "unavailable", quantity: 0 } });
  });

  it("preserves the existing price when an unsafe source price is suppressed", () => {
    const result = matchExistingWordPressVariations({
      items: [{
        source_variant_key: "outlier",
        size: { taxonomy: "pa_razmer", term_id: 10 },
        price: null,
        inventory: { availability: "unavailable", quantity: 0 },
      }],
      sourceTargetSizes: ["pa_razmer:10"],
      knownTargetSizes: ["pa_razmer:10"],
      ignored: [],
      deactivateAll: false,
    }, { product: { variations: [
      { variation_id: 500, attributes: [{ taxonomy: "pa_razmer", term_id: 10 }] },
    ] } });

    expect(result.items).toEqual([{
      variation_id: 500,
      size: { taxonomy: "pa_razmer", term_id: 10 },
      inventory: { availability: "unavailable", quantity: 0 },
    }]);
    expect(result.items[0]).not.toHaveProperty("price");
  });

  it("marks every existing variation unavailable when the source has no offers", () => {
    const result = matchExistingWordPressVariations({
      items: [],
      sourceTargetSizes: [],
      knownTargetSizes: [],
      ignored: [],
      deactivateAll: true,
    }, { product: { variations: [
      { variation_id: 500, attributes: [{ taxonomy: "pa_razmer", term_id: 10 }] },
      { variation_id: 501, attributes: [{ taxonomy: "pa_razmer", term_id: 11 }] },
    ] } });

    expect(result.items).toEqual([
      { variation_id: 500, size: { taxonomy: "pa_razmer", term_id: 10 }, inventory: { availability: "unavailable", quantity: 0 } },
      { variation_id: 501, size: { taxonomy: "pa_razmer", term_id: 11 }, inventory: { availability: "unavailable", quantity: 0 } },
    ]);
    expect(result.ignored).toEqual([]);
  });
});
