import type { JsonObject, TargetAssignmentDTO, UniversalProductDTO } from "../../contracts/index.js";
import type { TargetDictionaryRepository, TargetDictionaryValueRecord } from "../../repositories/index.js";
import type { SupplementalTargetAssignmentResolver } from "../../services/target-reference-mapping-service.js";

interface PreparedBrand {
  readonly dictionaryValueId: string;
  readonly externalId: string;
  readonly name: string;
  readonly tokens: readonly string[];
  readonly relatedTag?: {
    readonly dictionaryValueId: string;
    readonly externalId: string;
    readonly name: string;
  };
}

function textMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "string" && entry.trim() !== "" ? [[key, entry.trim()]] : []));
}

function normalizedTokens(value: string): readonly string[] {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/u).filter(Boolean);
}

function relatedTagExternalId(metadata: JsonObject): string | null {
  const rawMeta = metadata.rawMeta;
  if (rawMeta === null || typeof rawMeta !== "object" || Array.isArray(rawMeta)) return null;
  const value = (rawMeta as JsonObject).tag_id;
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^\d+$/u.test(text) && BigInt(text) > 0n ? text : null;
}

function canonicalBrand(values: readonly TargetDictionaryValueRecord[]): TargetDictionaryValueRecord | null {
  if (values.length === 1) return values[0]!;
  const related = values.filter((value) => relatedTagExternalId(value.metadata) !== null);
  return related.length === 1 ? related[0]! : null;
}

function containsAt(tokens: readonly string[], phrase: readonly string[], offset: number): boolean {
  return phrase.every((token, index) => tokens[offset + index] === token);
}

function withoutAudiencePrefix(tokens: readonly string[]): readonly string[] {
  const ignored = new Set(["wmns", "womens", "women", "mens", "men"]);
  let offset = 0;
  while (offset < tokens.length && ignored.has(tokens[offset]!)) offset += 1;
  if (offset > 0 && tokens[offset] === "s") offset += 1;
  return tokens.slice(offset);
}

function equalTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && containsAt(left, right, 0);
}

function withoutPrimaryBrand(
  segment: readonly string[],
  primaryBrand: readonly string[],
): readonly (readonly string[])[] {
  if (primaryBrand.length === 0 || primaryBrand.length >= segment.length) return [segment];
  const variants: (readonly string[])[] = [segment];
  if (containsAt(segment, primaryBrand, 0)) variants.push(segment.slice(primaryBrand.length));
  const suffixOffset = segment.length - primaryBrand.length;
  if (containsAt(segment, primaryBrand, suffixOffset)) variants.push(segment.slice(0, suffixOffset));
  return variants;
}

function collaboratingBrandSegments(
  titleTokens: readonly string[],
  brandTokens: readonly string[],
  primaryBrandTokens: readonly string[],
): readonly number[] {
  if (brandTokens.length === 0 || !titleTokens.includes("x")) return [];
  const segments: string[][] = [[]];
  for (const token of titleTokens) {
    if (token === "x") segments.push([]);
    else segments.at(-1)!.push(token);
  }
  return segments.flatMap((rawSegment, index) => {
    const segment = withoutAudiencePrefix(rawSegment);
    if (segment.length === 0) return [];
    if (index === segments.length - 1) {
      return brandTokens.length <= segment.length && containsAt(segment, brandTokens, 0) ? [index] : [];
    }
    return withoutPrimaryBrand(segment, primaryBrandTokens).some((variant) => equalTokens(variant, brandTokens))
      ? [index] : [];
  });
}

function primaryBrandTokens(product: UniversalProductDTO): readonly string[] {
  const brand = product.attributes.brand;
  if (typeof brand === "string" || typeof brand === "number") {
    return normalizedTokens(String(brand));
  }
  return [];
}

function assignmentsForTitle(
  product: UniversalProductDTO,
  brands: readonly PreparedBrand[],
  brandScope: string,
  tagScope: string,
): readonly TargetAssignmentDTO[] {
  if (!product.classification?.resolved.some((reference) => reference.typeCode === "brand")) return [];
  const titleTokens = normalizedTokens(product.title);
  const primaryTokens = primaryBrandTokens(product);
  const matches = brands.flatMap((brand) => collaboratingBrandSegments(titleTokens, brand.tokens, primaryTokens)
    .map((segment) => ({ brand, segment })));
  const longestBySegment = new Map<number, number>();
  for (const match of matches) {
    longestBySegment.set(match.segment, Math.max(longestBySegment.get(match.segment) ?? 0, match.brand.tokens.length));
  }
  const matchedBrands = [...new Map(matches
    .filter((match) => match.brand.tokens.length === longestBySegment.get(match.segment))
    .map((match) => [match.brand.dictionaryValueId, match.brand])).values()];
  const assignments: TargetAssignmentDTO[] = [];
  for (const brand of matchedBrands) {
    const groupCode = `title_brand_${brand.dictionaryValueId}`;
    assignments.push({
      ruleId: `dictionary:${brand.dictionaryValueId}`,
      groupCode,
      targetScope: brandScope,
      externalValue: brand.externalId,
      externalLabel: brand.name,
      mode: "add",
    });
    if (brand.relatedTag !== undefined) {
      assignments.push({
        ruleId: `dictionary:${brand.dictionaryValueId}:landing`,
        groupCode,
        targetScope: tagScope,
        externalValue: brand.relatedTag.externalId,
        externalLabel: brand.relatedTag.name,
        mode: "add",
      });
    }
  }
  return assignments;
}

export class WordPressTitleBrandAssignmentResolver implements SupplementalTargetAssignmentResolver {
  constructor(private readonly dictionaries: TargetDictionaryRepository) {}

  async createTargetAssignmentResolver(targetId: string) {
    const target = (await this.dictionaries.listTargets()).find((item) => item.id === targetId);
    const providerCode = typeof target?.config.dictionaryProviderCode === "string"
      ? target.config.dictionaryProviderCode.trim() : target?.exporterCode;
    if (target === undefined || providerCode !== "wordpress" || target.config.assignTitleBrandMentions !== true) {
      return (_product: UniversalProductDTO): readonly TargetAssignmentDTO[] => [];
    }
    const scopes = textMap(target.config.targetScopeMap);
    const brands = await this.dictionaries.listValues({
      targetId, entityType: "brands", limit: 100_000, offset: 0,
    });
    const byNormalizedName = new Map<string, TargetDictionaryValueRecord[]>();
    for (const brand of brands) {
      const key = normalizedTokens(brand.name).join(" ");
      if (key === "") continue;
      byNormalizedName.set(key, [...(byNormalizedName.get(key) ?? []), brand]);
    }
    const canonical = [...byNormalizedName.values()].map(canonicalBrand).filter((value) => value !== null);
    const tagExternalIds = [...new Set(canonical.map((brand) => relatedTagExternalId(brand.metadata)).filter((value) => value !== null))];
    const tags = await this.dictionaries.listValuesByExternalIds(targetId, tagExternalIds);
    const tagsByExternalId = new Map(tags.filter((tag) => tag.entityType === "tags")
      .map((tag) => [tag.externalId, tag]));
    const prepared = canonical.map((brand): PreparedBrand => {
      const tagId = relatedTagExternalId(brand.metadata);
      const tag = tagId === null ? undefined : tagsByExternalId.get(tagId);
      return {
        dictionaryValueId: brand.id,
        externalId: brand.externalId,
        name: brand.name,
        tokens: normalizedTokens(brand.name),
        ...(tag === undefined ? {} : { relatedTag: {
          dictionaryValueId: tag.id, externalId: tag.externalId, name: tag.name,
        } }),
      };
    });
    return (product: UniversalProductDTO) => assignmentsForTitle(
      product,
      prepared,
      scopes["product.brand"] ?? "product.brand",
      scopes["product.tag"] ?? "product.tag",
    );
  }
}
