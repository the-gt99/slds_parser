import type { ExportContext, ProductSizeDTO } from "../../contracts/index.js";

// GOAT's sneaker US Youth scale includes these children's sizes before 1Y.
// WordPress stores K terms under the existing `infant` mapping audience.
// Exact values keep unrelated sizes and size systems outside this rule.
const GOAT_YOUTH_KIDS_SIZES = new Set(["10.5", "11", "11.5", "12", "12.5", "13", "13.5"]);

export function resolveWordPressSourceSize(
  context: Pick<ExportContext, "source" | "product">,
  size: ProductSizeDTO,
): ProductSizeDTO {
  if (context.source.code.trim().toLowerCase() === "goat"
    && context.product.metadata.route === "sneakers"
    && size.system === "us-numeric"
    && size.audience === "youth"
    && GOAT_YOUTH_KIDS_SIZES.has(size.sourceValue)) {
    return { ...size, audience: "infant" };
  }
  return size;
}
