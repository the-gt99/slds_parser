import type { Availability, EntityId, MoneyDTO, UniversalProductDTO } from "./products.js";

/** Business-facing, source-neutral view. Processing and classification state is not part of this contract. */
export interface CommonProductDTO {
  readonly source: {
    readonly code: string;
    readonly productId: EntityId;
    readonly sourceKey: string;
    readonly externalId: string | null;
  };
  readonly title: string;
  readonly description: string;
  readonly sku: string | null;
  readonly characteristics: {
    readonly brand: string | null;
    readonly model: string | null;
    readonly family: string | null;
    readonly category: string | null;
    readonly color: string | null;
    readonly material: string | null;
    readonly shoeHeight: string | null;
    readonly audience: string | null;
    readonly activities: readonly string[];
    readonly ageGroups: readonly string[];
    readonly tags: readonly string[];
  };
  readonly images: readonly { readonly url: string; readonly alt: string; readonly position: number }[];
  readonly variants: readonly {
    readonly sourceVariantId: string;
    readonly sku: string | null;
    readonly size: { readonly value: string; readonly system: string | null };
    readonly price: MoneyDTO | null;
    readonly availability: Availability;
    readonly quantity: number | null;
  }[];
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Compatibility projection while persisted processing snapshots still use UniversalProductDTO v1. */
export function toCommonProductDTO(
  product: UniversalProductDTO,
  source: { readonly code: string },
  sourceProduct: { readonly id: EntityId; readonly sourceKey: string; readonly externalId?: string | null },
): CommonProductDTO {
  const candidate = (typeCode: string): string | null => optionalText(
    product.referenceCandidates.find((value) => value.subjectKind === "product" && value.typeCode === typeCode)?.sourceValue,
  );
  const tags = [...new Set(product.referenceCandidates
    .filter((value) => value.subjectKind === "product" && value.typeCode === "tag")
    .map((value) => optionalText(value.sourceValue))
    .filter((value): value is string => value !== null))];
  const activities = [...new Set(product.referenceCandidates
    .filter((value) => value.subjectKind === "product" && value.typeCode === "activity")
    .map((value) => optionalText(value.sourceValue))
    .filter((value): value is string => value !== null))];

  return {
    source: {
      code: source.code,
      productId: sourceProduct.id,
      sourceKey: sourceProduct.sourceKey,
      externalId: sourceProduct.externalId ?? null,
    },
    title: product.title,
    description: product.description,
    sku: optionalText(product.sku),
    characteristics: {
      brand: candidate("brand"),
      model: candidate("model"),
      family: optionalText(product.attributes.family),
      category: candidate("category"),
      color: candidate("color"),
      material: candidate("material"),
      shoeHeight: candidate("shoe_height"),
      audience: optionalText(product.attributes.audience) ?? optionalText(product.attributes.gender),
      activities,
      ageGroups: Array.isArray(product.attributes.ageGroups)
        ? product.attributes.ageGroups.filter((value): value is string => optionalText(value) !== null)
        : [],
      tags,
    },
    images: product.images.map(({ url, alt, position }) => ({ url, alt, position })),
    variants: product.variants.map((variant) => ({
      sourceVariantId: variant.sourceVariantKey,
      sku: optionalText(variant.sku),
      size: { value: variant.size.sourceValue, system: variant.size.system ?? null },
      price: variant.price,
      availability: variant.inventory.availability,
      quantity: variant.inventory.quantity ?? null,
    })),
  };
}
