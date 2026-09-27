import { RetryableError } from "../core/errors/index.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { createShihuoSignedHeaders, type ShihuoSignerConfig } from "./search-verifier.js";
import type { ShihuoGuestProfile } from "./types.js";
import { parseShihuoProductCard } from "./product-parser.js";
import type { ShihuoProductCard } from "./product-types.js";

const SEARCH_URL = "https://sh-gateway.shihuo.cn/v3/sh-api/daga/search/goods/v1";
const RISK_CODES = new Set(["7999", "90485", "90406"]);
const proxyAgents = new Map<string, ProxyAgent>();
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

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit, outboundProxyUrl?: string | null): Promise<Response> {
  if (!outboundProxyUrl) return fetchImpl(url, init);
  let dispatcher = proxyAgents.get(outboundProxyUrl);
  if (dispatcher === undefined) {
    dispatcher = new ProxyAgent(outboundProxyUrl);
    proxyAgents.set(outboundProxyUrl, dispatcher);
  }
  return undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

export interface ShihuoSearchCandidate { readonly goodsId: string; readonly styleId: string; }

export class ShihuoSearchClient {
  constructor(private readonly signer: ShihuoSignerConfig, private readonly fetchImpl: typeof fetch = fetch,
    private readonly createHeaders: typeof createShihuoSignedHeaders = createShihuoSignedHeaders) {}
  async searchAll(profile: ShihuoGuestProfile, article: string, outboundProxyUrl?: string | null): Promise<readonly ShihuoSearchCandidate[]> {
    const headers = await this.createHeaders(profile, this.signer);
    const keyword = article.trim().replace(/^([A-Za-z0-9]+)\s+([A-Za-z0-9]{3})$/u, "$1-$2");
    const payload = { from: "home", isHot: "false", keywords: keyword, needAttrs: 1, page: "1", pageSize: "20",
      page_route: "homeSearchList", predictSex: "2", use_type: "2", user_input: keyword };
    let response: Response;
    try {
      response = await request(this.fetchImpl, SEARCH_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(25_000) }, outboundProxyUrl);
    } catch (cause) {
      throw new RetryableError("Shihuo search request failed", { code: "SHIHUO_SEARCH_REQUEST_FAILED", cause });
    }
    let body: JsonRecord = {}; try { body = object(await response.json()); } catch { /* classified below */ }
    const risk = riskCode(response.status, body); if (risk) throw new ShihuoRiskError(risk);
    if (!response.ok) {
      if (response.status >= 500) {
        throw new RetryableError(`Shihuo search returned HTTP ${response.status}`, { code: "SHIHUO_SEARCH_HTTP_FAILED" });
      }
      throw new Error(`Shihuo search failed with safe status ${response.status}`);
    }
    const apiStatus = body.status ?? body.code;
    if (apiStatus !== 0) {
      throw new RetryableError(`Shihuo search returned API status ${String(apiStatus)}`, {
        code: "SHIHUO_SEARCH_RESPONSE_FAILED",
      });
    }
    const candidates: ShihuoSearchCandidate[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(object(body.data).lists) ? object(body.data).lists as unknown[] : []) {
      const item = object(raw); const goodsId = item.goods_id; const styleId = item.style_id;
      if ((typeof goodsId === "string" || typeof goodsId === "number") && (typeof styleId === "string" || typeof styleId === "number")) {
        const candidate = { goodsId: String(goodsId), styleId: String(styleId) };
        const key = `${candidate.goodsId}:${candidate.styleId}`;
        if (!seen.has(key)) { seen.add(key); candidates.push(candidate); }
      }
    }
    return candidates;
  }

  async searchFirst(profile: ShihuoGuestProfile, article: string, outboundProxyUrl?: string | null): Promise<ShihuoSearchCandidate | null> {
    return (await this.searchAll(profile, article, outboundProxyUrl))[0] ?? null;
  }
}

export class ShihuoProductClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async fetch(goodsId: string, styleId: string, outboundProxyUrl?: string | null): Promise<ShihuoProductCard> {
    const url = `https://www.shihuo.cn/page/pcGoodsDetail?goodsId=${encodeURIComponent(goodsId)}&styleId=${encodeURIComponent(styleId)}`;
    let response: Response;
    try {
      response = await request(this.fetchImpl, url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36", "accept-language": "zh-CN,zh;q=0.9,en;q=0.7" }, signal: AbortSignal.timeout(25_000) }, outboundProxyUrl);
    } catch (cause) {
      throw new RetryableError("Shihuo product-card request failed", { code: "SHIHUO_PRODUCT_CARD_REQUEST_FAILED", cause });
    }
    if (response.status === 429) throw new ShihuoRiskError("SHIHUO_HTTP_429");
    const document = await response.text();
    if (/captcha/iu.test(document)) throw new ShihuoRiskError("SHIHUO_CAPTCHA");
    if (!response.ok) throw new Error(`Shihuo card failed with safe status ${response.status}`);
    return parseShihuoProductCard(document, url, response.status);
  }
}
