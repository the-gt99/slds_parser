import { describe, expect, it, vi } from "vitest";
import { EcbShihuoCurrencyConverter, mergeWordPressInventoryDrafts, ShihuoInventoryService, type ShihuoProductCard } from "../../src/shihuo/index.js";

const card: ShihuoProductCard = {
  article: "DR0092-001", goodsId: "17", styleId: "39366158", title: "Nike", brand: "Nike", model: "Air",
  currency: "CNY", minPrice: "720", suppliers: [], attributes: { "货号": ["DR0092-001"] },
  variants: [
    { skuId: "a", size: "40", color: null, price: "720", currency: "CNY", available: true, quantity: null },
    { skuId: "b", size: "40", color: null, price: "700", currency: "CNY", available: true, quantity: null },
    { skuId: "c", size: "41", color: null, price: null, currency: "CNY", available: false, quantity: null },
  ], detailUrl: "https://www.shihuo.cn/page/pcGoodsDetail?goodsId=17&styleId=39366158", httpStatus: 200,
};

describe("Shihuo inventory integration", () => {
  it("converts CNY to USD using one common official ECB date and rounds acquisition cost up to cents", async () => {
    const csv = [
      "CURRENCY,TIME_PERIOD,OBS_VALUE",
      "CNY,2026-09-25,8.00000000",
      "USD,2026-09-25,1.20000000",
      "CNY,2026-09-24,7.90000000",
      "USD,2026-09-24,1.19000000",
    ].join("\n");
    const fetcher = vi.fn().mockResolvedValue(new Response(csv, { status: 200 }));
    const converter = new EcbShihuoCurrencyConverter(fetcher, () => 1_000);
    await expect(converter.cnyToUsd("100.01")).resolves.toBe("15.01");
    await expect(converter.cnyToUsd("100.01")).resolves.toBe("15.01");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps the lowest Shihuo offer per exact EU size and does not invent unavailable stock", async () => {
    const links = { getCard: vi.fn().mockResolvedValue({ card, contentHash: "a".repeat(64), loadedAt: "now" }) };
    const converter = { cnyToUsd: vi.fn(async (value: string) => value === "700" ? "97.00" : "100.00") };
    const service = new ShihuoInventoryService({} as never, links as never, converter as never);
    const variants = await service.variants("1", [{ size: { sourceValue: "8", displayValue: "8", system: "us-numeric", audience: "men" } }] as never);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ size: { sourceValue: "40", system: "eu-numeric", audience: "men" }, price: { amount: "97.00", currency: "USD" }, inventory: { availability: "available" } });
  });

  it.each(["men", "women", "youth", "infant", "unisex", " GS "])("uses explicit product audience %s when GOAT has no offers", async (audience) => {
    const links = { getCard: vi.fn().mockResolvedValue({ card }) };
    const converter = { cnyToUsd: vi.fn().mockResolvedValue("97.00") };
    const service = new ShihuoInventoryService({} as never, links as never, converter as never);
    const variants = await service.variants("1", [], audience);
    expect(variants[0]?.size.audience).toBe(audience === " GS " ? "youth" : audience);
    expect(variants[0]?.size.system).toBe("eu-numeric");
  });

  it("rejects unknown or conflicting audiences rather than guessing a size group", async () => {
    const service = new ShihuoInventoryService({} as never, { getCard: vi.fn().mockResolvedValue({ card }) } as never);
    await expect(service.variants("1", [], "adult")).rejects.toThrow("audience is ambiguous");
    await expect(service.variants("1", [])).rejects.toThrow("audience is ambiguous");
    await expect(service.variants("1", [
      { size: { audience: "men" } }, { size: { audience: "women" } },
    ] as never, "men")).rejects.toThrow("audience is ambiguous");
  });

  it("coalesces concurrent exchange-rate requests and allows a fresh retry after failure", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(new Response("CURRENCY,TIME_PERIOD,OBS_VALUE\nCNY,2026-09-25,8\nUSD,2026-09-25,1.2"));
    const converter = new EcbShihuoCurrencyConverter(fetcher);
    const first = converter.rate();
    const second = converter.rate();
    const results = Promise.allSettled([first, second]);
    expect(fetcher).toHaveBeenCalledOnce();
    finish(new Response("", { status: 503 }));
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    await expect(converter.rate()).resolves.toMatchObject({ date: "2026-09-25" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("selects the lower price only among available sources after both resolved to the same target size", () => {
    const base = { sourceTargetSizes: ["pa_razmer:10"], knownTargetSizes: ["pa_razmer:10"], ignored: [], deactivateAll: false };
    const goat = { ...base, items: [{ size: { taxonomy: "pa_razmer", term_id: 10 }, price: { source_currency: "USD", source_minor_amount: "12000" }, inventory: { availability: "available", quantity: 1 } }] };
    const shihuo = { ...base, items: [{ size: { taxonomy: "pa_razmer", term_id: 10 }, price: { source_currency: "USD", source_minor_amount: "9900" }, inventory: { availability: "available" } }] };
    expect(mergeWordPressInventoryDrafts(goat, shihuo).items[0]).toMatchObject({ price: { source_minor_amount: "9900" }, inventory: { availability: "available" } });
  });

  it("uses the available source even when the unavailable source has no usable price", () => {
    const base = { sourceTargetSizes: ["pa_razmer:10"], knownTargetSizes: ["pa_razmer:10"], ignored: [], deactivateAll: false };
    const goat = { ...base, items: [{ size: { taxonomy: "pa_razmer", term_id: 10 }, inventory: { availability: "unavailable", quantity: 0 } }] };
    const shihuo = { ...base, items: [{ size: { taxonomy: "pa_razmer", term_id: 10 }, price: { source_currency: "USD", source_minor_amount: "9900" }, inventory: { availability: "available" } }] };
    expect(mergeWordPressInventoryDrafts(goat, shihuo).items[0]).toMatchObject({ price: { source_minor_amount: "9900" }, inventory: { availability: "available" } });
  });
});
