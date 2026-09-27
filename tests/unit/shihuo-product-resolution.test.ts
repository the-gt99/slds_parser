import { describe, expect, it, vi } from "vitest";
import { normalizeShihuoArticle, parseShihuoProductCard, ShihuoGuestSessionPool, ShihuoProductResolver, shihuoArticlesMatch, ShihuoRiskError, type ShihuoProductCard, type ShihuoProductLink } from "../../src/shihuo/index.js";
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

  it("keeps SKU variants when the optional supplier block rejects an absent SkuId", () => {
    const next = { props: { pageProps: {
      styleBaseData: { status: 0, data: { style_id: 20, title: "Nike product" } },
      goodsBaseData: { status: 0, data: {} },
      skuBaseData: { status: 0, data: { goods_attr: [{ name: "货号", value: ["DQ0665-300"] }] } },
      skuListData: { status: 0, data: { list: [{ style_id: 20, sku_list: [{ sku_id: 1, price: "500", attrs: [{ spec_name: "尺码", name: "7" }] }] }] } },
      supplierListData: { status: 90000, msg: "Key: 'Request.SkuId' Error:Field validation for 'SkuId' failed on the 'required' tag", data: {} },
    } } };

    const value = parseShihuoProductCard(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`, "https://www.shihuo.cn/page/pcGoodsDetail?goodsId=10&styleId=20", 200);

    expect(value).toMatchObject({ article: "DQ0665-300", minPrice: "500", suppliers: [] });
    expect(value.variants).toHaveLength(1);
  });

  it("preserves exact articles from duplicate attribute groups", () => {
    const next = { props: { pageProps: {
      styleBaseData: { status: 0, data: { style_id: 20 } }, goodsBaseData: { status: 0, data: {} },
      skuBaseData: { status: 0, data: { goods_attr: [
        { name: "货号", value: ["DQ0665-300"] },
        { name: "货号", value: ["DH8053,DH8054"] },
      ] } },
      skuListData: { status: 0, data: { list: [] } }, supplierListData: { status: 0, data: { list: [] } },
    } } };

    const value = parseShihuoProductCard(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`, "https://www.shihuo.cn/page/pcGoodsDetail?goodsId=10&styleId=20", 200);

    expect(value.attributes["货号"]).toEqual(["DQ0665-300", "DH8053,DH8054"]);
    expect(value.article).toBe("DQ0665-300");
  });

  it("still rejects unrelated supplier block failures", () => {
    const next = { props: { pageProps: {
      styleBaseData: { status: 0, data: { style_id: 20 } }, goodsBaseData: { status: 0, data: {} },
      skuBaseData: { status: 0, data: { goods_attr: [] } }, skuListData: { status: 0, data: { list: [] } },
      supplierListData: { status: 500, msg: "upstream failed", data: {} },
    } } };

    expect(() => parseShihuoProductCard(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`, "https://www.shihuo.cn/page/pcGoodsDetail?goodsId=10&styleId=20", 200))
      .toThrow("Shihuo card block failed: supplierListData (500: upstream failed)");
  });

  it("does not save candidate ids before exact card verification", async () => {
    const lease = { profile: {}, success: vi.fn(), fail: vi.fn() };
    const links = { get: vi.fn().mockResolvedValue(null), savePending: vi.fn(), saveResolved: vi.fn(), saveOutcome: vi.fn(), touchCard: vi.fn(), saveCard: vi.fn() };
    const resolver = new ShihuoProductResolver({ acquire: vi.fn().mockResolvedValue(lease) } as never,
      { searchAll: vi.fn().mockResolvedValue([{ goodsId: "10", styleId: "20" }]) } as never,
      { fetch: vi.fn().mockResolvedValue(card("OTHER-001")) } as never, links as never, {} as never, 1100, vi.fn());
    const result = await resolver.resolveProductByArticle({ sourceProductId: "1", article: "DR0092-001" });
    expect(result.status).toBe("article_mismatch"); expect(links.saveResolved).not.toHaveBeenCalled();
    expect(links.saveOutcome).toHaveBeenCalledWith("1", "article_mismatch", "SHIHUO_ARTICLE_MISMATCH");
  });

  it("is idempotent for an already confirmed article", async () => {
    const search = { searchAll: vi.fn() }; const links = { get: vi.fn().mockResolvedValue(resolvedLink()) };
    const resolver = new ShihuoProductResolver({ acquire: vi.fn() } as never, search as never, {} as never, links as never, {} as never, 1100);
    await expect(resolver.resolveProductByArticle({ sourceProductId: "1", article: "dr0092 001" })).resolves.toMatchObject({ status: "resolved", goodsId: "10" });
    expect(search.searchAll).not.toHaveBeenCalled();
  });

  it("fetches a saved card without repeating search", async () => {
    const search = { searchAll: vi.fn() }; const products = { fetch: vi.fn().mockResolvedValue(card()) };
    const lease = { success: vi.fn(), fail: vi.fn() }; const links = { get: vi.fn().mockResolvedValue(resolvedLink()), touchCard: vi.fn(), saveCard: vi.fn() };
    const resolver = new ShihuoProductResolver({ acquire: vi.fn().mockResolvedValue(lease) } as never, search as never, products as never, links as never, {} as never, 1100);
    await resolver.fetchResolvedProductCard({ sourceProductId: "1" });
    expect(products.fetch).toHaveBeenCalledWith("10", "20"); expect(search.searchAll).not.toHaveBeenCalled(); expect(links.touchCard).toHaveBeenCalledOnce(); expect(links.saveCard).toHaveBeenCalledOnce();
  });

  it("puts only the leased device into risk cooldown", async () => {
    const risk = new ShihuoRiskError("SHIHUO_API_7999"); const lease = { profile: {}, success: vi.fn(), fail: vi.fn() };
    const links = { get: vi.fn().mockResolvedValue(null), savePending: vi.fn(), saveOutcome: vi.fn() };
    const resolver = new ShihuoProductResolver({ acquire: vi.fn().mockResolvedValue(lease) } as never,
      { searchAll: vi.fn().mockRejectedValue(risk) } as never, {} as never, links as never, {} as never, 1100);
    await expect(resolver.resolveProductByArticle({ sourceProductId: "1", article: "DR0092-001" })).rejects.toBe(risk);
    expect(lease.fail).toHaveBeenCalledWith("SHIHUO_API_7999", true);
    expect(links.saveOutcome).toHaveBeenCalledWith("1", "temporarily_blocked", "SHIHUO_API_7999");
    expect(JSON.stringify(risk)).not.toMatch(/token|sign|device/iu);
  });

  it("classifies an aborted Shihuo request as retryable", async () => {
    const lease = { profile: {}, success: vi.fn(), fail: vi.fn() };
    const links = { get: vi.fn().mockResolvedValue(null), savePending: vi.fn(), saveOutcome: vi.fn() };
    const resolver = new ShihuoProductResolver({ acquire: vi.fn().mockResolvedValue(lease) } as never,
      { searchAll: vi.fn().mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError")) } as never,
      {} as never, links as never, {} as never, 1100);

    await expect(resolver.resolveProductByArticle({ sourceProductId: "1", article: "DR0092-001" })).rejects.toMatchObject({
      name: "RetryableError",
      code: "SHIHUO_REQUEST_TIMEOUT",
    });
    expect(lease.fail).toHaveBeenCalledWith("SHIHUO_REQUEST_TIMEOUT", false);
    expect(links.saveOutcome).toHaveBeenCalledWith("1", "failed", "SHIHUO_REQUEST_TIMEOUT");
  });

  it("checks later search candidates until the exact article is confirmed", async () => {
    const lease = { profile: {}, success: vi.fn(), fail: vi.fn() };
    const links = { get: vi.fn().mockResolvedValue(null), savePending: vi.fn(), saveResolved: vi.fn(), saveOutcome: vi.fn(), saveCard: vi.fn() };
    const products = { fetch: vi.fn()
      .mockResolvedValueOnce(card("OTHER-001"))
      .mockResolvedValueOnce(card("DQ0665-300")) };
    const resolver = new ShihuoProductResolver({ acquire: vi.fn().mockResolvedValue(lease) } as never,
      { searchAll: vi.fn().mockResolvedValue([{ goodsId: "wrong", styleId: "1" }, { goodsId: "exact", styleId: "2" }]) } as never,
      products as never, links as never, {} as never, 1100, vi.fn());

    await expect(resolver.resolveProductByArticle({ sourceProductId: "1", article: "DQ0665 300" }))
      .resolves.toMatchObject({ status: "resolved", goodsId: "10", styleId: "20" });
    expect(products.fetch).toHaveBeenNthCalledWith(1, "wrong", "1");
    expect(products.fetch).toHaveBeenNthCalledWith(2, "exact", "2");
    expect(links.saveResolved).toHaveBeenCalledOnce();
  });

  it("uses one atomic SKIP LOCKED statement and permits expired leases", async () => {
    const executor = { query: vi.fn().mockResolvedValue({ rows: [{ id: 1, guest_profile_ciphertext: "cipher" }], rowCount: 1 }) };
    const repository = new PostgresShihuoSessionRepository(executor as never);
    await expect(repository.acquire("worker-1", 60)).resolves.toMatchObject({ deviceId: "1", leaseOwner: "worker-1" });
    const sql = executor.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED"); expect(sql).toContain("leased_until <= NOW()"); expect(sql).toContain("UPDATE shihuo_guest_devices");
  });

  it("reserves a session before the job and passes it to the resolver without a second lease", async () => {
    const repository = {
      acquire: vi.fn().mockResolvedValue({ deviceId: "7", leaseOwner: "owner", profileCiphertext: "cipher" }),
      releaseUnused: vi.fn(), releaseSuccess: vi.fn(), releaseFailure: vi.fn(),
    };
    const pool = new ShihuoGuestSessionPool(repository as never,
      { decrypt: vi.fn().mockReturnValue("{}") } as never,
      { sessionLeaseSeconds: 120, betweenProductsSeconds: 3, failureCooldownSeconds: 30, riskCooldownSeconds: 1800 } as never,
      () => Date.parse("2026-09-27T12:00:00Z"));

    const permit = await pool.reserveClaim();
    expect(permit).not.toBeNull();
    await permit!.run(async () => {
      const lease = await pool.acquire();
      expect(lease?.deviceId).toBe("7");
      await lease?.success();
    });

    expect(repository.acquire).toHaveBeenCalledOnce();
    expect(repository.releaseSuccess).toHaveBeenCalledWith("7", expect.any(String), "2026-09-27T12:00:03.000Z");
    expect(repository.releaseUnused).not.toHaveBeenCalled();
  });

  it("releases a reserved session immediately when no job was claimed", async () => {
    const repository = {
      acquire: vi.fn().mockResolvedValue({ deviceId: "7", leaseOwner: "owner", profileCiphertext: "cipher" }),
      releaseUnused: vi.fn(), releaseSuccess: vi.fn(), releaseFailure: vi.fn(),
    };
    const pool = new ShihuoGuestSessionPool(repository as never,
      { decrypt: vi.fn().mockReturnValue("{}") } as never,
      { sessionLeaseSeconds: 120, betweenProductsSeconds: 3, failureCooldownSeconds: 30, riskCooldownSeconds: 1800 } as never);

    const permit = await pool.reserveClaim();
    await permit?.releaseUnused();

    expect(repository.releaseUnused).toHaveBeenCalledWith("7", expect.any(String));
    expect(repository.releaseSuccess).not.toHaveBeenCalled();
  });

  it("releases a lease with cooldown and clears its owner", async () => {
    const executor = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const repository = new PostgresShihuoSessionRepository(executor as never);
    await repository.releaseFailure("7", "worker-1", "2026-09-25T12:00:00Z", "SHIHUO_API_7999", false);
    const [sql, values] = executor.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("lease_owner=NULL"); expect(sql).toContain("next_available_at=$3");
    expect(values).toEqual(["7", "worker-1", "2026-09-25T12:00:00Z", "SHIHUO_API_7999", false]);
  });

  it("releases an unused lease without applying a product cooldown", async () => {
    const executor = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const repository = new PostgresShihuoSessionRepository(executor as never);

    await repository.releaseUnused("7", "worker-1");

    const [sql, values] = executor.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("lease_owner=NULL");
    expect(sql).not.toContain("next_available_at");
    expect(values).toEqual(["7", "worker-1"]);
  });
});
