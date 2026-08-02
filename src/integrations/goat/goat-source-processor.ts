import type { JsonObject, JsonValue, MoneyDTO, ProcessingContext, ProductImageDTO, ProductVariantDTO, ReferenceCandidateDTO, SourceProcessor, UniversalProductDTO } from "../../contracts/index.js";
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

function facts(values: Readonly<Record<string, string>>): JsonObject {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
}

function namedValues(value: JsonValue | undefined): string[] {
  const entries = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const unique = new Map<string, string>();
  for (const entry of entries) {
    const sourceValue = typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? text(entry.name ?? entry.label ?? entry.value ?? entry.title)
      : text(entry);
    const trimmed = sourceValue.trim();
    const normalized = trimmed.toLocaleLowerCase("en-US");
    if (trimmed !== "" && !unique.has(normalized)) unique.set(normalized, trimmed);
  }
  return [...unique.values()];
}

function candidate(
  key: string,
  typeCode: string,
  scope: string,
  sourceValue: string,
  context: JsonObject,
  evidence: JsonObject,
  subjectKey?: string,
): ReferenceCandidateDTO | null {
  if (sourceValue.trim() === "") return null;
  return {
    key,
    typeCode,
    scope,
    subjectKind: subjectKey === undefined ? "product" : "variant",
    ...(subjectKey === undefined ? {} : { subjectKey }),
    sourceValue,
    context,
    evidence,
  };
}

function appendCandidate(list: ReferenceCandidateDTO[], value: ReferenceCandidateDTO | null): void {
  if (value !== null) list.push(value);
}

export class GoatSourceProcessor implements SourceProcessor {
  readonly sourceCode = "goat";
  readonly version = "2.3.0";

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
    const title = text(product.name);
    const description = text(product.story) || text(product.description);
    const brand = text(product.brandName) || text(product.brand);
    const family = text(product.silhouette);
    const gender = text(product.singleGender) || text(product.gender);
    const categoryRaw = Array.isArray(product.category) ? text(product.category[0]) : text(product.productCategory);
    const productCategory = text(product.productCategory);
    const productType = text(product.productType);
    const sizeType = text(product.sizeType);
    const sizeUnit = text(product.sizeUnit);
    const route = text(context.sourceProduct.metadata.route);
    const taxonomy: Record<string, JsonValue> = {};
    for (const key of ["taxonomyLevel1", "taxonomyLevel2", "taxonomyLevel3", "taxonomyLevel4"] as const) {
      if (product[key] !== undefined) taxonomy[key] = product[key]!;
    }
    const productEvidence: JsonObject = {
      ...facts({ title, brand, family, audience: gender, category: categoryRaw || productCategory, productCategory, productType, route }),
      ...(Object.keys(taxonomy).length === 0 ? {} : { taxonomy }),
    };
    const variants: ProductVariantDTO[] = [];
    const referenceCandidates: ReferenceCandidateDTO[] = [];
    appendCandidate(referenceCandidates, candidate("product:brand", "brand", "product.brand", brand, {}, productEvidence));
    appendCandidate(referenceCandidates, candidate("product:model", "model", "product.model", title, facts({ brand, family }), productEvidence));
    appendCandidate(referenceCandidates, candidate("product:category", "category", "product.category", categoryRaw || productCategory,
      facts({ route, productCategory, productType, audience: gender }), productEvidence));
    appendCandidate(referenceCandidates, candidate("product:color", "color", "product.color", text(product.color), {}, productEvidence));
    appendCandidate(referenceCandidates, candidate("product:material", "material", "product.material", text(product.upperMaterial), {}, productEvidence));
    const technologies = namedValues(product.technologies);
    const midsole = text(product.midsole).trim();
    if (midsole !== "" && !technologies.some((value) => value.toLocaleLowerCase("en-US") === midsole.toLocaleLowerCase("en-US"))) {
      technologies.unshift(midsole);
    }
    technologies.forEach((value, index) => appendCandidate(referenceCandidates,
      candidate(`product:tag:technology:${index}`, "tag", "product.tag.technology", value, {}, productEvidence)));
    const activities = namedValues(product.activitiesList ?? product.activities);
    if (categoryRaw !== "" && !activities.some((value) => value.toLocaleLowerCase("en-US") === categoryRaw.toLocaleLowerCase("en-US"))) {
      activities.push(categoryRaw);
    }
    activities.forEach((value, index) => {
      appendCandidate(referenceCandidates,
        candidate(`product:activity:${index}`, "activity", "product.activity", value, facts({ productCategory, productType }), productEvidence));
      appendCandidate(referenceCandidates,
        candidate(`product:tag:activity:${index}`, "tag", "product.tag.activity", value, {}, productEvidence));
    });
    namedValues(product.tags).forEach((value, index) => appendCandidate(referenceCandidates,
      candidate(`product:tag:source:${index}`, "tag", "product.tag.source", value, {}, productEvidence)));
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
        inventory: { availability: availability(stockStatus) },
        attributes: { shoeCondition, boxCondition, stockStatus, countryCode,
          ...(instantShipPrice ? { instantShipPrice: { amount: instantShipPrice.amount, currency: instantShipPrice.currency } } : {}),
          ...(lastSoldPrice ? { lastSoldPrice: { amount: lastSoldPrice.amount, currency: lastSoldPrice.currency } } : {}) } });
    }
    return { sourceProductId: context.sourceProduct.id, title, description, sku: text(product.sku),
      images: images(product.images, title), variants, referenceCandidates,
      attributes: { brand: product.brandName ?? product.brand ?? null, family, gender, color: product.color ?? null,
        story: product.story ?? product.description ?? null, details: product.details ?? null, upperMaterial: product.upperMaterial ?? null,
        midsole: product.midsole ?? null, categoryRaw,
        productCategory: product.productCategory ?? null, productType: product.productType ?? null, taxonomy,
        season: product.season ?? null, releaseDate: product.releaseDate ?? null, status: product.status ?? null },
      metadata: { source: "goat", productId, slug: product.slug ?? context.sourceProduct.slug ?? null, route: route || null, countryCode,
        sizeType: product.sizeType ?? null, sizeUnit: product.sizeUnit ?? null } };
  }
}
