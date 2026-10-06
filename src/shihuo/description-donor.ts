import type { JsonObject, UniversalProductDTO } from "../contracts/index.js";
import type { ProductContentDonor } from "../application/content-enrichment-runner.js";
import type { ContentEnrichmentRecord } from "../repositories/content-enrichment-repository.js";
import type { ShihuoProductCard, ShihuoProductLinkRepository } from "./product-types.js";
import type { ShihuoProductResolver } from "./product-resolver.js";
import { normalizeShihuoArticle, shihuoArticlesMatch } from "./product-parser.js";

function normalized(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
function brand(value: string): string {
  const key = normalized(value.split("/")[0] ?? "");
  const aliases: Readonly<Record<string,string>> = {
    adidasoriginals: "adidas", airjordan: "jordanbrand", hoka: "hokaoneone",
    clarksoriginals: "clarks", dc: "dcshoes",
  };
  return aliases[key] ?? key;
}
export function descriptionIdentityMatches(product: UniversalProductDTO, card: ShihuoProductCard): boolean {
  const sourceBrand = typeof product.attributes.brand === "string" ? product.attributes.brand : "";
  const family = typeof product.attributes.family === "string" ? normalized(product.attributes.family) : "";
  const articles = card.attributes["货号"] ?? [];
  // A multi-article aggregate cannot prove that its prose belongs to this exact item.
  return sourceBrand !== "" && card.brand !== null && brand(sourceBrand) === brand(card.brand)
    && family.length >= 3 && normalized(`${card.model ?? ""} ${card.title ?? ""}`).includes(family)
    && articles.length === 1 && shihuoArticlesMatch(product.sku ?? "",articles[0]!);
}

const featureNames = new Set(["货号","球鞋配置","中底系统","关键技术","鞋面材质","鞋底材料","闭合方式","鞋帮高度","鞋钉类型"]);
export function cleanShihuoDescription(product: UniversalProductDTO, card: ShihuoProductCard): {
  readonly text: string; readonly reason: string | null;
} {
  const raw = card.structuredProduct;
  const description = typeof raw?.description === "string" ? raw.description : "";
  if (description.length === 0 || description.length > 20000) return { text: "", reason: "description_absent_or_too_long" };
  const markers = ["可选配色","可选尺码","全网价格区间","在功能配置方面"];
  const positions = markers.map((marker) => description.indexOf(marker));
  if (positions.some((position,index) => position < 0 || (index > 0 && position <= positions[index-1]!))
    || markers.some((marker) => description.indexOf(marker) !== description.lastIndexOf(marker))) {
    return { text: "", reason: "description_template_unknown" };
  }
  const tail = description.slice(positions[3]!);
  if (/(?:元|渠道|最低价|可选配色|可选尺码|全网价格区间)/u.test(tail)) return { text: "", reason: "dynamic_tail" };
  const properties = Array.isArray(raw?.additionalProperty) ? raw.additionalProperty : [];
  const pairs = properties.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    return typeof entry.name === "string" && typeof entry.value === "string" ? [{ name: entry.name,value: entry.value }] : [];
  });
  const articles = pairs.filter((pair) => pair.name === "货号");
  if (articles.length !== 1 || !shihuoArticlesMatch(product.sku ?? "",articles[0]!.value)) return { text: "", reason: "description_article_mismatch" };
  const facts = pairs.filter((pair) => featureNames.has(pair.name) && pair.value.trim() !== ""
    && tail.includes(`${pair.name}为${pair.value}`));
  if (facts.some((pair) => pair.name === "鞋钉类型" && /\bAG\b/u.test(pair.value) && /\bFG\b/u.test(pair.value))) {
    return { text: "", reason: "ambiguous_stud_types" };
  }
  if (facts.some((pair) => pair.name === "闭合方式" && pair.value.split("、").length > 2)) {
    return { text: "", reason: "aggregate_closure_types" };
  }
  if (facts.filter((pair) => pair.name !== "货号").length === 0) return { text: "", reason: "no_product_features" };
  const sourceBrand = String(product.attributes.brand ?? "");
  // Keep the exact catalog title, not the source's model-wide promotional SEO title.
  const text = `商品名称：${product.title}。品牌：${sourceBrand}。${facts.map((pair) => `${pair.name}：${pair.value}`).join("。 ")}。`;
  return { text, reason: null };
}

export class ShihuoDescriptionDonor implements ProductContentDonor {
  readonly code = "shihuo";
  readonly version = "1.0.0";
  constructor(private readonly resolver: ShihuoProductResolver, private readonly links: ShihuoProductLinkRepository,
    private readonly targetLocale: string) {}
  async collect(product: UniversalProductDTO): Promise<ReturnType<ProductContentDonor["collect"]> extends Promise<infer T> ? T : never> {
    const link = await this.links.get(product.sourceProductId);
    const base = { sourceProductId: product.sourceProductId,donorCode: this.code,article: product.sku ?? "",
      sourceLocale: "zh-CN",targetLocale: this.targetLocale,parserVersion: this.version };
    if (link?.status !== "resolved" || !link.goodsId || !link.styleId
      || normalizeShihuoArticle(link.sourceArticle) !== normalizeShihuoArticle(product.sku ?? "")) {
      return { ...base,donorProductKey: "",rawPayload: {},cleanedText: "",status: "skipped",reason: "unconfirmed_link" };
    }
    const card = await this.resolver.fetchResolvedProductCard({ sourceProductId: product.sourceProductId });
    const rawPayload: JsonObject = { product: card.structuredProduct ?? {}, title: card.title,brand: card.brand,
      model: card.model,article: card.article,attributes: card.attributes,detailUrl: card.detailUrl };
    const key = `${card.goodsId}:${card.styleId}`;
    if (!descriptionIdentityMatches(product,card)) return { ...base,donorProductKey: key,rawPayload,
      cleanedText: "",status: "skipped",reason: "description_identity_unproven" };
    const cleaned = cleanShihuoDescription(product,card);
    return { ...base,donorProductKey: key,rawPayload,cleanedText: cleaned.text,
      status: cleaned.reason === null ? "collected" : "skipped",reason: cleaned.reason };
  }
  async validate(product: UniversalProductDTO, record: ContentEnrichmentRecord): Promise<boolean> {
    if (record.parserVersion !== this.version || record.donorCode !== this.code) return false;
    const link = await this.links.get(product.sourceProductId);
    if (link?.status !== "resolved" || `${link.goodsId}:${link.styleId}` !== record.donorProductKey
      || !shihuoArticlesMatch(product.sku ?? "",record.article)) return false;
    const saved = await this.links.getCard(product.sourceProductId);
    return saved !== null && descriptionIdentityMatches(product,saved.card);
  }
}
