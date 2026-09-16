import { describe, expect, it } from "vitest";
import type { ProductSizeDTO } from "../../src/contracts/index.js";
import { resolveWordPressSourceSize } from "../../src/integrations/wordpress/wordpress-size-rules.js";

const context = {
  source: { id: "1", code: "goat", config: {} },
  product: { sourceProductId: "1", title: "Shoe", description: "", sku: "", images: [], variants: [],
    referenceCandidates: [], attributes: {}, metadata: { route: "sneakers" } },
};
const size = (value: string): ProductSizeDTO => ({ sourceValue: value, displayValue: value, system: "us-numeric", audience: "youth" });

describe("WordPress source size rules", () => {
  it.each(["10.5", "11", "11.5", "12", "12.5", "13", "13.5"])("resolves GOAT Youth %s as K without changing the input", (value) => {
    const input = Object.freeze(size(value));
    expect(resolveWordPressSourceSize(context, input)).toEqual({ ...input, audience: "infant" });
    expect(input.audience).toBe("youth");
  });
  it.each(["1", "1.5", "3", "3.5", "7", "8", "10", "10.25", "14", "16", "10.5-11"])("does not infer a group for %s", (value) => {
    const input = size(value);
    expect(resolveWordPressSourceSize(context, input)).toBe(input);
  });
  it.each(["men", "women", "infant", "unisex"] as const)("preserves %s sizes", (audience) => {
    const input = { ...size("11"), audience };
    expect(resolveWordPressSourceSize(context, input)).toBe(input);
  });
  it.each(["eu-numeric", "uk-numeric", "us-alpha"])("preserves %s systems", (system) => {
    const input = { ...size("11"), system };
    expect(resolveWordPressSourceSize(context, input)).toBe(input);
  });
  it("requires both the source and sneaker route evidence", () => {
    const input = size("11");
    expect(resolveWordPressSourceSize({ ...context, source: { ...context.source, code: "other" } }, input)).toBe(input);
    for (const metadata of [{}, { route: "apparel" }]) {
      expect(resolveWordPressSourceSize({ ...context, product: { ...context.product, metadata } }, input)).toBe(input);
    }
  });
});
