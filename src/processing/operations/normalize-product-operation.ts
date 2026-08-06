import type {
  JsonObject,
  JsonValue,
  ProductImageDTO,
  ProductOperation,
  ProductOperationContext,
  ReferenceCandidateDTO,
  ProductVariantDTO,
  UniversalProductDTO,
} from "../../contracts/index.js";

const SPREADSHEET_ERROR_TOKENS = new Set([
  "#REF!",
  "#VALUE!",
  "#NAME?",
  "#DIV/0!",
  "#N/A",
  "#NUM!",
  "#NULL!",
  "#SPILL!",
  "#CALC!",
  "#ERROR!",
  "#FIELD!",
  "#GETTING_DATA",
]);

const PRODUCT_ATTRIBUTE_TEXT_FIELDS = [
  "brand",
  "family",
  "model",
  "gender",
  "color",
  "story",
  "details",
  "upperMaterial",
  "midsole",
  "composition",
  "categoryRaw",
  "productCategory",
  "productType",
  "season",
  "releaseDate",
  "status",
] as const;

const VARIANT_ATTRIBUTE_TEXT_FIELDS = [
  "shoeCondition",
  "boxCondition",
  "stockStatus",
  "countryCode",
] as const;

const METADATA_TEXT_FIELDS = ["source", "productId", "slug", "countryCode", "sizeType", "sizeUnit"] as const;

export function cleanSourceText(value: string): string {
  const text = value.trim();
  if (text === "") return "";
  return SPREADSHEET_ERROR_TOKENS.has(text.toUpperCase()) ? "" : text;
}

function cleanTextFields(value: JsonObject, fields: readonly string[]): JsonObject {
  const result: Record<string, JsonValue> = { ...value };
  for (const field of fields) {
    const current = result[field];
    if (typeof current === "string") result[field] = cleanSourceText(current);
  }
  return result;
}

function isGoatPlaceholder(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return path.includes("/placeholders/product_templates/") || path.endsWith("/missing.png") || path.endsWith("/missing.webp");
}

function normalizeImages(
  images: readonly ProductImageDTO[],
  context: ProductOperationContext,
): readonly ProductImageDTO[] {
  const seen = new Set<string>();
  const result: ProductImageDTO[] = [];

  for (const image of images) {
    const sourceUrl = cleanSourceText(image.sourceUrl ?? image.url);
    if (sourceUrl === "" || seen.has(sourceUrl)) continue;
    if (context.source.code === "goat" && isGoatPlaceholder(sourceUrl)) continue;
    seen.add(sourceUrl);
    result.push({
      ...image,
      sourceUrl,
      url: sourceUrl,
      position: result.length,
      alt: cleanSourceText(image.alt),
    });
  }

  return result;
}

function normalizeVariant(variant: ProductVariantDTO): ProductVariantDTO {
  return {
    ...variant,
    sourceVariantKey: cleanSourceText(variant.sourceVariantKey),
    sku: cleanSourceText(variant.sku),
    size: {
      ...variant.size,
      sourceValue: cleanSourceText(variant.size.sourceValue),
      displayValue: cleanSourceText(variant.size.displayValue),
      ...(variant.size.system === undefined ? {} : { system: cleanSourceText(variant.size.system).toLocaleLowerCase("en-US") }),
    },
    price: variant.price === null
      ? null
      : {
          amount: cleanSourceText(variant.price.amount),
          currency: cleanSourceText(variant.price.currency).toUpperCase(),
        },
    attributes: cleanTextFields(variant.attributes, VARIANT_ATTRIBUTE_TEXT_FIELDS),
  };
}

function normalizeCandidate(candidate: ReferenceCandidateDTO): ReferenceCandidateDTO {
  const cleanObject = (value: JsonObject): JsonObject => Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, typeof entry === "string" ? cleanSourceText(entry) : entry]),
  );
  return {
    ...candidate,
    key: candidate.key.trim(),
    typeCode: candidate.typeCode.trim(),
    scope: candidate.scope.trim(),
    ...(candidate.subjectKey === undefined ? {} : { subjectKey: cleanSourceText(candidate.subjectKey) }),
    sourceValue: cleanSourceText(candidate.sourceValue),
    context: cleanObject(candidate.context),
    evidence: cleanObject(candidate.evidence),
  };
}

export class NormalizeProductOperation implements ProductOperation {
  readonly code = "normalize-product";
  readonly name = "Нормализация товара";
  readonly version = "2.1.0";

  async execute(
    product: UniversalProductDTO,
    context: ProductOperationContext,
  ): Promise<UniversalProductDTO> {
    return {
      ...product,
      title: cleanSourceText(product.title),
      description: cleanSourceText(product.description),
      sku: cleanSourceText(product.sku),
      images: normalizeImages(product.images, context),
      variants: product.variants.map(normalizeVariant),
      referenceCandidates: product.referenceCandidates.map(normalizeCandidate),
      attributes: cleanTextFields(product.attributes, PRODUCT_ATTRIBUTE_TEXT_FIELDS),
      metadata: cleanTextFields(product.metadata, METADATA_TEXT_FIELDS),
    };
  }
}
