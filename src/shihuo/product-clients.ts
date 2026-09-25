import { RetryableError } from "../core/errors/index.js";
import { createShihuoSignedHeaders, type ShihuoSignerConfig } from "./search-verifier.js";
import type { ShihuoGuestProfile } from "./types.js";
import { parseShihuoProductCard } from "./product-parser.js";
import type { ShihuoProductCard } from "./product-types.js";

const SEARCH_URL = "https://sh-gateway.shihuo.cn/v3/sh-api/daga/search/goods/v1";
const RISK_CODES = new Set(["7999", "90485", "90406"]);
type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

export class ShihuoRiskError extends RetryableError {
  constructor(code: string) { super("Shihuo session was temporarily blocked", { code }); }
}

function riskCode(responseStatus: number, body?: JsonRecord): string | null {
  if (responseStatus === 429) return "SHIHUO_HTTP_429";
  const code = String(body?.status ?? body?.code ?? "");
  if (RISK_CODES.has(code)) return `SHIHUO_API_${code}`;
  const message = String(body?.msg ?? body?.message ?? "").toLowerCase();
  return message.includes("captcha") ? "SHIHUO_CAPTCHA" : null;
}

export interface ShihuoSearchCandidate { readonly goodsId: string; readonly styleId: string; }

export class ShihuoSearchClient {
  constructor(private readonly signer: ShihuoSignerConfig, private readonly fetchImpl: typeof fetch = fetch) {}
  async searchFirst(profile: ShihuoGuestProfile, article: string): Promise<ShihuoSearchCandidate | null> {
    const headers = await createShihuoSignedHeaders(profile, this.signer);
    const keyword = article.trim().replace(/^([A-Za-z0-9]+)\s+([A-Za-z0-9]{3})$/u, "$1-$2");
    const payload = { from: "home", isHot: "false", keywords: keyword, needAttrs: 1, page: "1", pageSize: "20",
      page_route: "homeSearchList", predictSex: "2", use_type: "2", user_input: keyword };
    const response = await this.fetchImpl(SEARCH_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(25_000) });
    let body: JsonRecord = {}; try { body = object(await response.json()); } catch { /* classified below */ }
    const risk = riskCode(response.status, body); if (risk) throw new ShihuoRiskError(risk);
    if (!response.ok || (body.status ?? body.code) !== 0) throw new Error(`Shihuo search failed with safe status ${response.status}`);
    for (const raw of Array.isArray(object(body.data).lists) ? object(body.data).lists as unknown[] : []) {
      const item = object(raw); const goodsId = item.goods_id; const styleId = item.style_id;
      if ((typeof goodsId === "string" || typeof goodsId === "number") && (typeof styleId === "string" || typeof styleId === "number")) {
        return { goodsId: String(goodsId), styleId: String(styleId) };
      }
    }
    return null;
  }
}

export class ShihuoProductClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async fetch(goodsId: string, styleId: string): Promise<ShihuoProductCard> {
    const url = `https://www.shihuo.cn/page/pcGoodsDetail?goodsId=${encodeURIComponent(goodsId)}&styleId=${encodeURIComponent(styleId)}`;
    const response = await this.fetchImpl(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36", "accept-language": "zh-CN,zh;q=0.9,en;q=0.7" }, signal: AbortSignal.timeout(25_000) });
    if (response.status === 429) throw new ShihuoRiskError("SHIHUO_HTTP_429");
    const document = await response.text();
    if (/captcha/iu.test(document)) throw new ShihuoRiskError("SHIHUO_CAPTCHA");
    if (!response.ok) throw new Error(`Shihuo card failed with safe status ${response.status}`);
    return parseShihuoProductCard(document, url, response.status);
  }
}
