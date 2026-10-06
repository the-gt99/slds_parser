import { EntityNotFoundError, RetryableError } from "../core/errors/index.js";
import type { EntityId } from "../contracts/index.js";
import type { InternalProductRepository } from "../repositories/index.js";
import { normalizeShihuoArticle, shihuoArticlesMatch } from "./product-parser.js";
import { ShihuoProductClient, ShihuoRiskError, ShihuoSearchClient } from "./product-clients.js";
import { ShihuoGuestSessionPool } from "./guest-session-pool.js";
import type { ShihuoProductCard, ShihuoProductLinkRepository, ShihuoResolutionResult } from "./product-types.js";
import { SHIHUO_IDENTITY_REJECTED } from "./product-types.js";

function normalizeShihuoRequestError(error: unknown): unknown {
  if (error instanceof RetryableError) return error;
  if (error instanceof Error
    && /^Shihuo card block failed: supplierListData/iu.test(error.message)
    && /(timeout|context deadline exceeded|"code"\s*:\s*408)/iu.test(error.message)) {
    return new RetryableError("Shihuo supplier data timed out", {
      code: "SHIHUO_SUPPLIER_TIMEOUT",
      cause: error,
    });
  }
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new RetryableError("Shihuo request timed out", { code: "SHIHUO_REQUEST_TIMEOUT", cause: error });
  }
  return error;
}

export class ShihuoProductResolver {
  constructor(private readonly sessions: ShihuoGuestSessionPool, private readonly search: ShihuoSearchClient,
    private readonly products: ShihuoProductClient, private readonly links: ShihuoProductLinkRepository,
    private readonly internalProducts: InternalProductRepository, private readonly betweenRequestsMs: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}

  async resolveProductByArticle(input: { readonly sourceProductId: EntityId; readonly article: string }): Promise<ShihuoResolutionResult> {
    const normalized = normalizeShihuoArticle(input.article);
    const existing = await this.links.get(input.sourceProductId);
    if (existing?.status === "article_mismatch" && existing.normalizedArticle === normalized
      && existing.lastErrorCode === SHIHUO_IDENTITY_REJECTED) {
      return { status: "article_mismatch", sourceProductId: input.sourceProductId, article: input.article,
        errorCode: SHIHUO_IDENTITY_REJECTED };
    }
    if (existing?.status === "resolved" && existing.normalizedArticle === normalized && existing.goodsId && existing.styleId) {
      return { status: "resolved", sourceProductId: input.sourceProductId, article: input.article, goodsId: existing.goodsId, styleId: existing.styleId };
    }
    await this.links.savePending(input.sourceProductId, input.article, normalized);
    const lease = await this.sessions.acquire();
    if (!lease) { await this.links.saveOutcome(input.sourceProductId, "temporarily_blocked", "SHIHUO_NO_SESSION"); throw new RetryableError("No Shihuo guest session is available", { code: "SHIHUO_NO_SESSION" }); }
    try {
      const candidates = await this.search.searchAll(lease.profile, input.article, lease.outboundProxyUrl ?? null);
      if (candidates.length === 0) { await lease.success(); await this.links.saveOutcome(input.sourceProductId, "not_found", null); return { status: "not_found", sourceProductId: input.sourceProductId, article: input.article }; }
      for (const candidate of candidates) {
        await this.sleep(this.betweenRequestsMs);
        const loadedCard = await this.products.fetch(candidate.goodsId, candidate.styleId, lease.outboundProxyUrl ?? null);
        const confirmedArticle = loadedCard.attributes["货号"]?.find((value) => shihuoArticlesMatch(input.article, value));
        if (!confirmedArticle) continue;
        const card = { ...loadedCard, article: confirmedArticle };
        const now = new Date().toISOString(); await this.links.saveResolved({ ...input, normalizedArticle: normalized, confirmedArticle, goodsId: card.goodsId, styleId: card.styleId, loadedAt: now }); await this.links.saveCard(input.sourceProductId, card, now); await lease.success();
        return { status: "resolved", sourceProductId: input.sourceProductId, article: input.article, goodsId: card.goodsId, styleId: card.styleId, card };
      }
      await lease.success(); await this.links.saveOutcome(input.sourceProductId, "article_mismatch", "SHIHUO_ARTICLE_MISMATCH");
      return { status: "article_mismatch", sourceProductId: input.sourceProductId, article: input.article };
    } catch (error) {
      const failure = normalizeShihuoRequestError(error);
      const risk = failure instanceof ShihuoRiskError; const code = failure instanceof Error && "code" in failure ? String(failure.code) : "SHIHUO_REQUEST_FAILED";
      await lease.fail(code, risk); await this.links.saveOutcome(input.sourceProductId, risk ? "temporarily_blocked" : "failed", code); throw failure;
    }
  }

  async resolveSourceProduct(sourceProductId: EntityId): Promise<ShihuoResolutionResult> {
    const internal = await this.internalProducts.findBySourceProductId(sourceProductId); if (!internal) throw new EntityNotFoundError("Internal product", sourceProductId);
    const article = internal.data.sku?.trim(); if (!article) throw new Error("Source product has no article");
    return await this.resolveProductByArticle({ sourceProductId, article });
  }

  async fetchResolvedProductCard(input: { readonly sourceProductId: EntityId }): Promise<ShihuoProductCard> {
    const link = await this.links.get(input.sourceProductId); if (!link || link.status !== "resolved" || !link.goodsId || !link.styleId) throw new EntityNotFoundError("Resolved Shihuo product", input.sourceProductId);
    const lease = await this.sessions.acquire(); if (!lease) throw new RetryableError("No Shihuo guest session is available", { code: "SHIHUO_NO_SESSION" });
    try { const loadedCard = await this.products.fetch(link.goodsId, link.styleId, lease.outboundProxyUrl ?? null); const confirmedArticle = loadedCard.attributes["货号"]?.find((value) => shihuoArticlesMatch(link.sourceArticle, value)); if (!confirmedArticle) throw new Error("Stored Shihuo product article no longer matches"); const card = { ...loadedCard, article: confirmedArticle }; const now = new Date().toISOString(); await this.links.touchCard(input.sourceProductId, now); await this.links.saveCard(input.sourceProductId, card, now); await lease.success(); return card; }
    catch (error) { const failure = normalizeShihuoRequestError(error); const risk = failure instanceof ShihuoRiskError; const code = failure instanceof Error && "code" in failure ? String(failure.code) : "SHIHUO_REQUEST_FAILED"; await lease.fail(code, risk); throw failure; }
  }
}
