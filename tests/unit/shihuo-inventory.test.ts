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
