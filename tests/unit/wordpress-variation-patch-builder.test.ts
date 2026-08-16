import { describe, expect, it } from "vitest";

import { matchExistingWordPressVariations } from "../../src/integrations/wordpress/index.js";

describe("matchExistingWordPressVariations", () => {
  it("updates only exact existing sizes and records absent sizes", () => {
    const result = matchExistingWordPressVariations({
      items: [
        { source_variant_key: "a", size: { taxonomy: "pa_razmer", term_id: 10 }, price: { source_currency: "USD", source_minor_amount: "10000" }, inventory: { availability: "available" } },
        { source_variant_key: "b", size: { taxonomy: "pa_razmer", term_id: 11 }, price: { source_currency: "USD", source_minor_amount: "12000" }, inventory: { availability: "available" } },
      ],
      sourceTargetSizes: ["pa_razmer:10", "pa_razmer:11"],
      knownTargetSizes: ["pa_razmer:10", "pa_razmer:11"],
      ignored: [],
    }, { product: { variations: [{ variation_id: 500, attributes: [{ taxonomy: "pa_razmer", term_id: 10 }] }] } });
    expect(result.items).toEqual([expect.objectContaining({ variation_id: 500, size: { taxonomy: "pa_razmer", term_id: 10 } })]);
    expect(result.ignored).toEqual([expect.objectContaining({ sourceVariantKey: "b", reason: expect.stringContaining("не создаётся") })]);
  });

  it("blocks duplicate existing variations for one size", () => {
    expect(() => matchExistingWordPressVariations({
      items: [{ source_variant_key: "a", size: { taxonomy: "pa_razmer", term_id: 10 }, inventory: { availability: "available" } }],
      sourceTargetSizes: ["pa_razmer:10"],
      knownTargetSizes: ["pa_razmer:10"],
      ignored: [],
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
});
