import type { ShihuoProductCard } from "./product-types.js";

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | null => typeof value === "string" || typeof value === "number" ? String(value) : null;

export function normalizeShihuoArticle(value: string): string {
  return value.toUpperCase().replace(/[\s-]+/gu, "");
}

export function shihuoArticlesMatch(left: string, right: string): boolean {
  const normalized = normalizeShihuoArticle(left);
  return normalized.length > 0 && normalized === normalizeShihuoArticle(right);
}

function unwrap(props: JsonRecord, key: string): JsonRecord {
  const block = object(props[key]);
  const status = block.status;
  if (status !== undefined && status !== null && status !== 0) throw new Error(`Shihuo card block failed: ${key}`);
  return object(block.data);
}

export function parseShihuoProductCard(document: string, detailUrl: string, httpStatus: number): ShihuoProductCard {
  const match = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/iu.exec(document);
  if (!match?.[1]) throw new Error("Shihuo card does not contain __NEXT_DATA__");
  const root = object(JSON.parse(match[1]) as unknown);
  const props = object(object(root.props).pageProps);
  const style = unwrap(props, "styleBaseData");
  unwrap(props, "goodsBaseData");
  const skuBase = unwrap(props, "skuBaseData");
  const skuData = unwrap(props, "skuListData");
  const supplierData = unwrap(props, "supplierListData");
  const url = new URL(detailUrl);
  const goodsId = url.searchParams.get("goodsId") ?? "";
  const styleId = text(style.style_id) ?? url.searchParams.get("styleId") ?? "";
  if (!goodsId || !styleId) throw new Error("Shihuo card identifiers are missing");
  const attributes: Record<string, string[]> = {};
  for (const raw of array(skuBase.goods_attr)) {
    const item = object(raw); const name = text(item.name); if (!name) continue;
    attributes[name] = array(item.value).map(text).filter((value): value is string => value !== null);
  }
  const groups = array(skuData.list).map(object);
  const group = groups.find((item) => text(item.style_id) === styleId) ?? groups[0] ?? {};
  const variants = array(group.sku_list).map((raw) => {
    const sku = object(raw); const attrs = new Map<string, string>();
    for (const value of array(sku.attrs).map(object)) { const key = text(value.spec_name); const val = text(value.name); if (key && val) attrs.set(key, val); }
    const rawPrice = text(sku.price); const numeric = rawPrice === null ? Number.NaN : Number(rawPrice); const price = Number.isFinite(numeric) && numeric > 0 ? rawPrice : null;
    return { skuId: text(sku.sku_id) ?? "", size: attrs.get("尺码") ?? null, color: attrs.get("颜色") ?? null,
      price, currency: "CNY" as const, available: price !== null, quantity: null };
  });
  const suppliers = array(supplierData.list).map((raw) => {
    const supplier = object(object(raw).supplier_info);
    return { name: text(supplier.supplier_name), store: text(supplier.store_name), price: text(supplier.display_price), currency: "CNY" as const };
  });
  const article = attributes["货号"]?.[0] ?? "";
  const prices = variants.flatMap((variant) => variant.price === null ? [] : [{ raw: variant.price, numeric: Number(variant.price) }]).filter((value) => Number.isFinite(value.numeric));
  const minPrice = prices.reduce<{ raw: string; numeric: number } | null>((lowest, value) => lowest === null || value.numeric < lowest.numeric ? value : lowest, null)?.raw ?? null;
  return { article, goodsId, styleId, title: text(style.title), brand: text(style.root_brand_name), model: text(style.child_brand_name),
    currency: "CNY", minPrice, variants, suppliers, attributes,
    detailUrl, httpStatus };
}
