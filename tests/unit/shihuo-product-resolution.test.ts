import { describe, expect, it, vi } from "vitest";
import { normalizeShihuoArticle, parseShihuoProductCard, ShihuoProductResolver, shihuoArticlesMatch, ShihuoRiskError, type ShihuoProductCard, type ShihuoProductLink } from "../../src/shihuo/index.js";
import { PostgresShihuoSessionRepository } from "../../src/infrastructure/db/index.js";

const card = (article = "DR0092-001"): ShihuoProductCard => ({ article, goodsId: "10", styleId: "20", title: "Nike product", brand: "Nike", model: "Air",
  currency: "CNY", minPrice: "500", variants: [], suppliers: [], attributes: { "货号": [article] }, detailUrl: "https://www.shihuo.cn/page/pcGoodsDetail?goodsId=10&styleId=20", httpStatus: 200 });
const resolvedLink = (): ShihuoProductLink => ({ sourceProductId: "1", sourceArticle: "DR0092-001", normalizedArticle: "DR0092001", goodsId: "10", styleId: "20", status: "resolved", confirmedArticle: "DR0092-001", confirmedAt: "now", lastCardLoadedAt: "now", lastErrorCode: null });

describe("Shihuo product resolution", () => {
  it("normalizes only spaces, hyphens and case for exact comparison", () => {
    expect(normalizeShihuoArticle(" dr0092 - 001 ")).toBe("DR0092001");
    expect(shihuoArticlesMatch("DR0092-001", "dr0092 001")).toBe(true);
    expect(shihuoArticlesMatch("DR0092-001", "DR0092")).toBe(false);
    expect(shihuoArticlesMatch("DR0092-001", "DR0092-002")).toBe(false);
  });

  it("parses confirmed fields without inventing price or quantity", () => {
    const next = { props: { pageProps: {
      styleBaseData: { status: 0, data: { style_id: 20, title: "Nike product", root_brand_name: "Nike", child_brand_name: "Air" } },
      goodsBaseData: { status: 0, data: {} }, skuBaseData: { status: 0, data: { goods_attr: [{ name: "货号", value: ["DR0092-001"] }] } },
      skuListData: { status: 0, data: { list: [{ style_id: 20, sku_list: [{ sku_id: 1, price: "0", attrs: [{ spec_name: "尺码", name: "42" }] }] }] } },
      supplierListData: { status: 0, data: { list: [] } },
    } } };
    const value = parseShihuoProductCard(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`, "https://www.shihuo.cn/page/pcGoodsDetail?goodsId=10&styleId=20", 200);
    expect(value).toMatchObject({ article: "DR0092-001", goodsId: "10", styleId: "20", minPrice: null });
    expect(value.variants[0]).toMatchObject({ size: "42", price: null, available: false, quantity: null });
  });

  it("does not save candidate ids before exact card verification", async () => {
    const lease = { profile: {}, success: vi.fn(), fail: vi.fn() };
    const links = { get: vi.fn().mockResolvedValue(null), savePending: vi.fn(), saveResolved: vi.fn(), saveOutcome: vi.fn(), touchCard: vi.fn() };
    const resolver = new ShihuoProductResolver({ acquire: vi.fn().mockResolvedValue(lease) } as never,
      { searchFirst: vi.fn().mockResolvedValue({ goodsId: "10", styleId: "20" }) } as never,
      { fetch: vi.fn().mockResolvedValue(card("OTHER-001")) } as never, links as never, {} as never, 1100, vi.fn());
    const result = await resolver.resolveProductByArticle({ sourceProductId: "1", article: "DR0092-001" });
    expect(result.status).toBe("article_mismatch"); expect(links.saveResolved).not.toHaveBeenCalled();
    expect(links.saveOutcome).toHaveBeenCalledWith("1", "article_mismatch", "SHIHUO_ARTICLE_MISMATCH");
  });

  it("is idempotent for an already confirmed article", async () => {
    const search = { searchFirst: vi.fn() }; const links = { get: vi.fn().mockResolvedValue(resolvedLink()) };
    const resolver = new ShihuoProductResolver({ acquire: vi.fn() } as never, search as never, {} as never, links as never, {} as never, 1100);
    await expect(resolver.resolveProductByArticle({ sourceProductId: "1", article: "dr0092 001" })).resolves.toMatchObject({ status: "resolved", goodsId: "10" });
    expect(search.searchFirst).not.toHaveBeenCalled();
  });

  it("fetches a saved card without repeating search", async () => {
    const search = { searchFirst: vi.fn() }; const products = { fetch: vi.fn().mockResolvedValue(card()) };
    const lease = { success: vi.fn(), fail: vi.fn() }; const links = { get: vi.fn().mockResolvedValue(resolvedLink()), touchCard: vi.fn() };
    const resolver = new ShihuoProductResolver({ acquire: vi.fn().mockResolvedValue(lease) } as never, search as never, products as never, links as never, {} as never, 1100);
    await resolver.fetchResolvedProductCard({ sourceProductId: "1" });
    expect(products.fetch).toHaveBeenCalledWith("10", "20"); expect(search.searchFirst).not.toHaveBeenCalled(); expect(links.touchCard).toHaveBeenCalledOnce();
  });

  it("puts only the leased device into risk cooldown", async () => {
    const risk = new ShihuoRiskError("SHIHUO_API_7999"); const lease = { profile: {}, success: vi.fn(), fail: vi.fn() };
    const links = { get: vi.fn().mockResolvedValue(null), savePending: vi.fn(), saveOutcome: vi.fn() };
    const resolver = new ShihuoProductResolver({ acquire: vi.fn().mockResolvedValue(lease) } as never,
      { searchFirst: vi.fn().mockRejectedValue(risk) } as never, {} as never, links as never, {} as never, 1100);
    await expect(resolver.resolveProductByArticle({ sourceProductId: "1", article: "DR0092-001" })).rejects.toBe(risk);
    expect(lease.fail).toHaveBeenCalledWith("SHIHUO_API_7999", true);
    expect(links.saveOutcome).toHaveBeenCalledWith("1", "temporarily_blocked", "SHIHUO_API_7999");
    expect(JSON.stringify(risk)).not.toMatch(/token|sign|device/iu);
  });

  it("uses one atomic SKIP LOCKED statement and permits expired leases", async () => {
    const executor = { query: vi.fn().mockResolvedValue({ rows: [{ id: 1, guest_profile_ciphertext: "cipher" }], rowCount: 1 }) };
    const repository = new PostgresShihuoSessionRepository(executor as never);
    await expect(repository.acquire("worker-1", 60)).resolves.toMatchObject({ deviceId: "1", leaseOwner: "worker-1" });
    const sql = executor.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED"); expect(sql).toContain("leased_until <= NOW()"); expect(sql).toContain("UPDATE shihuo_guest_devices");
  });

  it("releases a lease with cooldown and clears its owner", async () => {
    const executor = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const repository = new PostgresShihuoSessionRepository(executor as never);
    await repository.releaseFailure("7", "worker-1", "2026-09-25T12:00:00Z", "SHIHUO_API_7999", false);
    const [sql, values] = executor.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("lease_owner=NULL"); expect(sql).toContain("next_available_at=$3");
    expect(values).toEqual(["7", "worker-1", "2026-09-25T12:00:00Z", "SHIHUO_API_7999", false]);
  });
});
