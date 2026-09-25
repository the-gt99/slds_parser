import { EntityNotFoundError, RetryableError } from "../core/errors/index.js";
import type { EntityId } from "../contracts/index.js";
import type { InternalProductRepository } from "../repositories/index.js";
import { normalizeShihuoArticle, shihuoArticlesMatch } from "./product-parser.js";
import { ShihuoProductClient, ShihuoRiskError, ShihuoSearchClient } from "./product-clients.js";
import { ShihuoGuestSessionPool } from "./guest-session-pool.js";
import type { ShihuoProductCard, ShihuoProductLinkRepository, ShihuoResolutionResult } from "./product-types.js";

export class ShihuoProductResolver {
  constructor(private readonly sessions: ShihuoGuestSessionPool, private readonly search: ShihuoSearchClient,
    private readonly products: ShihuoProductClient, private readonly links: ShihuoProductLinkRepository,
    private readonly internalProducts: InternalProductRepository, private readonly betweenRequestsMs: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}

  async resolveProductByArticle(input: { readonly sourceProductId: EntityId; readonly article: string }): Promise<ShihuoResolutionResult> {
    const normalized = normalizeShihuoArticle(input.article);
    const existing = await this.links.get(input.sourceProductId);
    if (existing?.status === "resolved" && existing.normalizedArticle === normalized && existing.goodsId && existing.styleId) {
      return { status: "resolved", sourceProductId: input.sourceProductId, article: input.article, goodsId: existing.goodsId, styleId: existing.styleId };
    }
    await this.links.savePending(input.sourceProductId, input.article, normalized);
    const lease = await this.sessions.acquire();
    if (!lease) { await this.links.saveOutcome(input.sourceProductId, "temporarily_blocked", "SHIHUO_NO_SESSION"); throw new RetryableError("No Shihuo guest session is available", { code: "SHIHUO_NO_SESSION" }); }
    try {
      const candidate = await this.search.searchFirst(lease.profile, input.article);
      if (!candidate) { await lease.success(); await this.links.saveOutcome(input.sourceProductId, "not_found", null); return { status: "not_found", sourceProductId: input.sourceProductId, article: input.article }; }
      await this.sleep(this.betweenRequestsMs);
      const loadedCard = await this.products.fetch(candidate.goodsId, candidate.styleId);
      const confirmedArticle = loadedCard.attributes["货号"]?.find((value) => shihuoArticlesMatch(input.article, value));
      if (!confirmedArticle) { await lease.success(); await this.links.saveOutcome(input.sourceProductId, "article_mismatch", "SHIHUO_ARTICLE_MISMATCH"); return { status: "article_mismatch", sourceProductId: input.sourceProductId, article: input.article }; }
      const card = { ...loadedCard, article: confirmedArticle };
      const now = new Date().toISOString(); await this.links.saveResolved({ ...input, normalizedArticle: normalized, confirmedArticle, goodsId: card.goodsId, styleId: card.styleId, loadedAt: now }); await lease.success();
      return { status: "resolved", sourceProductId: input.sourceProductId, article: input.article, goodsId: card.goodsId, styleId: card.styleId, card };
    } catch (error) {
      const risk = error instanceof ShihuoRiskError; const code = error instanceof Error && "code" in error ? String(error.code) : "SHIHUO_REQUEST_FAILED";
      await lease.fail(code, risk); await this.links.saveOutcome(input.sourceProductId, risk ? "temporarily_blocked" : "failed", code); throw error;
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
    try { const loadedCard = await this.products.fetch(link.goodsId, link.styleId); const confirmedArticle = loadedCard.attributes["货号"]?.find((value) => shihuoArticlesMatch(link.sourceArticle, value)); if (!confirmedArticle) throw new Error("Stored Shihuo product article no longer matches"); const card = { ...loadedCard, article: confirmedArticle }; await this.links.touchCard(input.sourceProductId, new Date().toISOString()); await lease.success(); return card; }
    catch (error) { const risk = error instanceof ShihuoRiskError; const code = error instanceof Error && "code" in error ? String(error.code) : "SHIHUO_REQUEST_FAILED"; await lease.fail(code, risk); throw error; }
  }
}
