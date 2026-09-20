import { describe, expect, it } from "vitest";

import { toCommonProductDTO, type UniversalProductDTO } from "../../src/contracts/index.js";

describe("toCommonProductDTO", () => {
  it("projects source-neutral facts without processing or classifier internals", () => {
    const product: UniversalProductDTO = {
      sourceProductId: "42", title: "Shirt", description: "Cotton shirt", sku: "",
      attributes: { gender: "women", story: "Donor-only story", productType: "Tops", family: "Sportswear", ageGroups: ["adult"] },
      metadata: { route: "apparel" },
      images: [{ url: "https://cdn.example/shirt.webp", position: 0, alt: "Shirt", localPath: "private/path", attributes: {} }],
      variants: [{ sourceVariantKey: "v1", sku: "", size: { sourceValue: "M", displayValue: "M", system: "standard-clothing" }, price: null, inventory: { availability: "unknown" }, attributes: {} }],
      referenceCandidates: [
        { key: "brand", typeCode: "brand", scope: "product.brand", subjectKind: "product", sourceValue: "Nike", context: {}, evidence: {} },
        { key: "category", typeCode: "category", scope: "product.category", subjectKind: "product", sourceValue: "Tops", context: {}, evidence: {} },
        { key: "tag", typeCode: "tag", scope: "product.tag", subjectKind: "product", sourceValue: "Running", context: {}, evidence: {} },
      ],
    };

    const result = toCommonProductDTO(product, { code: "goat" }, { id: "42", sourceKey: "shirt-42", externalId: null });

    expect(result).toMatchObject({
      source: { code: "goat", productId: "42", sourceKey: "shirt-42", externalId: null },
      sku: null,
      characteristics: { brand: "Nike", category: "Tops", family: "Sportswear", shoeHeight: null, audience: "women",
        activities: [], ageGroups: ["adult"], tags: ["Running"] },
      images: [{ url: "https://cdn.example/shirt.webp", alt: "Shirt", position: 0 }],
      variants: [{ sourceVariantId: "v1", sku: null, size: { value: "M", system: "standard-clothing" }, price: null, availability: "unknown", quantity: null }],
    });
    expect(result).not.toHaveProperty("metadata");
    expect(result).not.toHaveProperty("referenceCandidates");
    expect(result.characteristics).not.toHaveProperty("productType");
    expect(result.characteristics).not.toHaveProperty("route");
    expect(result.images[0]).not.toHaveProperty("localPath");
  });
  it("does not infer family or age from title, model or audience", () => {
    const product: UniversalProductDTO = { sourceProductId: "1", title: "Air Max Kids", sku: "", description: "",
      attributes: { gender: "kids" }, metadata: {}, referenceCandidates: [], images: [], variants: [] };
    const project = (attributes: UniversalProductDTO["attributes"]) => toCommonProductDTO(
      { ...product, attributes }, { code: "another-donor" }, { id: "1", sourceKey: "one" },
    ).characteristics;
    expect(project(product.attributes)).toMatchObject({ family: null, ageGroups: [], audience: "kids" });
    expect(project({ family: " ", ageGroups: ["youth", "", " ", null, 3] })).toMatchObject({ family: null, ageGroups: ["youth"] });
    expect(project({ ageGroups: "adult" }).ageGroups).toEqual([]);
  });
});
