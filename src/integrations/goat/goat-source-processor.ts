import type { JsonObject, JsonValue, MoneyDTO, ProcessingContext, ProductImageDTO, ProductVariantDTO, SourceProcessor, UniversalProductDTO } from "../../contracts/index.js";
import { IntegrationContractError } from "../../core/errors/index.js";

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new IntegrationContractError(`GOAT ${label} part has invalid shape`);
  return value as JsonObject;
}
function text(value: JsonValue | undefined): string { return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value); }
function money(value: JsonValue | undefined): MoneyDTO | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const objectValue = value as JsonObject;
  const amount = objectValue.amount;
  const currency = objectValue.currency;
  if ((typeof amount !== "number" && typeof amount !== "string") || typeof currency !== "string") return null;
  const cents = String(amount);
  if (!/^-?\d+$/.test(cents)) throw new IntegrationContractError("GOAT money amount must be integer cents");
  const negative = cents.startsWith("-");
  const digits = negative ? cents.slice(1) : cents;
  const padded = digits.padStart(3, "0");
  const decimal = `${padded.slice(0, -2)}.${padded.slice(-2)}`;
  return { amount: negative ? `-${decimal}` : decimal, currency };
}
function availability(value: string): ProductVariantDTO["inventory"]["availability"] {
  if (value === "not_in_stock") return "unavailable";
  if (value === "single_in_stock" || value === "multiple_in_stock") return "available";
  return "unknown";
}
function images(value: JsonValue | undefined, title: string): ProductImageDTO[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, position) => {
    const url = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? text(entry.url ?? entry.imageUrl) : "";
    return url ? [{ url, position, alt: title, attributes: {} }] : [];
  });
}

export class GoatSourceProcessor implements SourceProcessor {
  readonly sourceCode = "goat";
  readonly version = "1.1.0";

  async process(context: ProcessingContext): Promise<UniversalProductDTO> {
    const productPart = context.parts.find((part) => part.partKey === "product");
    const offersPart = context.parts.find((part) => part.partKey === "offers");
    if (!productPart || !offersPart) throw new IntegrationContractError("GOAT product and offers parts are required");
    const product = object(productPart.parsedPayload, "product");
    const offersPayload = object(offersPart.parsedPayload, "offers");
    if (!Array.isArray(offersPayload.offers)) throw new IntegrationContractError("GOAT offers array is required");
    const productId = text(product.id);
    const countryCode = text(offersPayload.countryCode);
    if (!productId || !countryCode) throw new IntegrationContractError("GOAT product id and country code are required");
    const variants: ProductVariantDTO[] = [];
    const keys = new Set<string>();
    for (const value of offersPayload.offers) {
      const offer = object(value, "offer");
      const size = object(offer.sizeOption, "offer sizeOption");
      const sourceValue = text(size.value);
      const displayValue = text(size.presentation);
      const shoeCondition = text(offer.shoeCondition);
      const boxCondition = text(offer.boxCondition);
      const stockStatus = text(offer.stockStatus);
      if (!sourceValue) throw new IntegrationContractError("GOAT offer size value is required");
      const key = [productId, countryCode, sourceValue, shoeCondition, boxCondition].join("|");
      if (keys.has(key)) throw new IntegrationContractError(`Duplicate GOAT variant key: ${key}`);
      keys.add(key);
      const primaryPrice = money(offer.lowestPriceCents);
      const instantShipPrice = money(offer.instantShipLowestPriceCents);
      const lastSoldPrice = money(offer.lastSoldPriceCents);
      variants.push({ sourceVariantKey: key, sku: [text(product.sku) || productId, sourceValue, shoeCondition, boxCondition].filter(Boolean).join("-"),
        size: { sourceValue, displayValue: displayValue || sourceValue }, price: primaryPrice,
        inventory: { availability: availability(stockStatus) }, conditionReferenceId: null,
        attributes: { shoeCondition, boxCondition, stockStatus, countryCode,
          ...(instantShipPrice ? { instantShipPrice: { amount: instantShipPrice.amount, currency: instantShipPrice.currency } } : {}),
          ...(lastSoldPrice ? { lastSoldPrice: { amount: lastSoldPrice.amount, currency: lastSoldPrice.currency } } : {}) } });
    }
    const title = text(product.name);
    const description = text(product.story) || text(product.description);
    const model = text(product.silhouette);
    const gender = text(product.singleGender) || text(product.gender);
    const categoryRaw = Array.isArray(product.category) ? text(product.category[0]) : text(product.productCategory);
    const taxonomy: Record<string, JsonValue> = {};
    for (const key of ["taxonomyLevel1", "taxonomyLevel2", "taxonomyLevel3", "taxonomyLevel4"] as const) if (product[key] !== undefined) taxonomy[key] = product[key]!;
    // TODO: Map GOAT brand, gender, category and condition values to internal references.
    return { sourceProductId: context.sourceProduct.id, title, description, sku: text(product.sku),
      brandReferenceId: null, categoryReferenceIds: [], genderReferenceId: null,
      images: images(product.images, title), variants,
      attributes: { brand: product.brandName ?? product.brand ?? null, model, gender, color: product.color ?? null,
        story: product.story ?? product.description ?? null, details: product.details ?? null, upperMaterial: product.upperMaterial ?? null,
        midsole: product.midsole ?? null, categoryRaw,
        productCategory: product.productCategory ?? null, productType: product.productType ?? null, taxonomy,
        season: product.season ?? null, releaseDate: product.releaseDate ?? null, status: product.status ?? null },
      metadata: { source: "goat", productId, slug: product.slug ?? context.sourceProduct.slug ?? null, countryCode,
        sizeType: product.sizeType ?? null, sizeUnit: product.sizeUnit ?? null } };
  }
}
