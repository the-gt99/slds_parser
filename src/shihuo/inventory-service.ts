import type { JsonObject, ProductVariantDTO } from "../contracts/index.js";
import { IntegrationContractError, RetryableError } from "../core/errors/index.js";
import type { WordPressVariationPatchDraft } from "../integrations/wordpress/index.js";
import type { ShihuoProductCard, ShihuoProductLinkRepository } from "./product-types.js";
import type { ShihuoProductResolver } from "./product-resolver.js";

const ECB_RATES_URL = "https://data-api.ecb.europa.eu/service/data/EXR/D.CNY+USD.EUR.SP00.A?format=csvdata&lastNObservations=10";

function decimalMinor(value: string): bigint | null {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/u.exec(value.trim());
  if (match === null) return null;
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

function scaledRate(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (match === null) return null;
  return BigInt(match[1]!) * 100_000_000n + BigInt((match[2] ?? "").slice(0, 8).padEnd(8, "0"));
}

export interface ShihuoCurrencyRate {
  readonly date: string;
  readonly cnyPerEur: string;
  readonly usdPerEur: string;
}

export class EcbShihuoCurrencyConverter {
  private cached: { readonly rate: ShihuoCurrencyRate; readonly expiresAt: number } | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  async rate(): Promise<ShihuoCurrencyRate> {
    if (this.cached !== null && this.cached.expiresAt > this.now()) return this.cached.rate;
    let response: Response;
    try {
      response = await this.fetchImpl(ECB_RATES_URL, { headers: { Accept: "text/csv" }, signal: AbortSignal.timeout(15_000) });
    } catch (cause) {
      throw new RetryableError("ECB exchange-rate request failed", { code: "SHIHUO_EXCHANGE_RATE_REQUEST_FAILED", cause });
    }
    if (!response.ok) throw new RetryableError(`ECB exchange-rate request failed with HTTP ${response.status}`, { code: "SHIHUO_EXCHANGE_RATE_HTTP_ERROR" });
    const lines = (await response.text()).trim().split(/\r?\n/u);
    const header = lines.shift()?.split(",") ?? [];
    const currencyIndex = header.indexOf("CURRENCY");
    const dateIndex = header.indexOf("TIME_PERIOD");
    const valueIndex = header.indexOf("OBS_VALUE");
    if (currencyIndex < 0 || dateIndex < 0 || valueIndex < 0) throw new IntegrationContractError("ECB exchange-rate response has no required columns");
    const byDate = new Map<string, Map<string, string>>();
    for (const line of lines) {
      const cells = line.split(",");
      const currency = cells[currencyIndex]?.trim();
      const date = cells[dateIndex]?.trim();
      const value = cells[valueIndex]?.trim();
      if ((currency !== "CNY" && currency !== "USD") || !date || !value || scaledRate(value) === null) continue;
      const values = byDate.get(date) ?? new Map<string, string>();
      values.set(currency, value);
      byDate.set(date, values);
    }
    const selected = [...byDate.entries()].filter(([, values]) => values.has("CNY") && values.has("USD"))
      .sort(([left], [right]) => right.localeCompare(left))[0];
    if (selected === undefined) throw new IntegrationContractError("ECB exchange-rate response has no common CNY and USD date");
    const rate = { date: selected[0], cnyPerEur: selected[1].get("CNY")!, usdPerEur: selected[1].get("USD")! };
    this.cached = { rate, expiresAt: this.now() + 6 * 60 * 60 * 1000 };
    return rate;
  }

  async cnyToUsd(value: string): Promise<string> {
    const cnyMinor = decimalMinor(value);
    if (cnyMinor === null || cnyMinor <= 0n) throw new IntegrationContractError(`Invalid Shihuo CNY price: ${value}`);
    const rate = await this.rate();
    const cnyPerEur = scaledRate(rate.cnyPerEur)!;
    const usdPerEur = scaledRate(rate.usdPerEur)!;
    const numerator = cnyMinor * usdPerEur;
    const usdMinor = (numerator + cnyPerEur - 1n) / cnyPerEur;
    return `${usdMinor / 100n}.${String(usdMinor % 100n).padStart(2, "0")}`;
  }
}

export type ShihuoRefreshResult =
  | { readonly status: "resolved"; readonly cardHash: string }
  | { readonly status: "not_found" | "article_mismatch" };

export class ShihuoInventoryService {
  constructor(private readonly resolver: ShihuoProductResolver, private readonly links: ShihuoProductLinkRepository,
    private readonly currency: EcbShihuoCurrencyConverter = new EcbShihuoCurrencyConverter()) {}

  async refresh(sourceProductId: string): Promise<ShihuoRefreshResult> {
    const resolution = await this.resolver.resolveSourceProduct(sourceProductId);
    if (resolution.status === "not_found" || resolution.status === "article_mismatch") return { status: resolution.status };
    if (resolution.status !== "resolved") throw new RetryableError(`Shihuo resolution is not ready: ${resolution.status}`, { code: "SHIHUO_RESOLUTION_NOT_READY" });
    if (resolution.card === undefined) await this.resolver.fetchResolvedProductCard({ sourceProductId });
    const saved = await this.links.getCard(sourceProductId);
    if (saved === null) throw new IntegrationContractError(`Shihuo card was not saved for source product ${sourceProductId}`);
    return { status: "resolved", cardHash: saved.contentHash };
  }

  async variants(sourceProductId: string, goatVariants: readonly ProductVariantDTO[]): Promise<readonly ProductVariantDTO[]> {
    const saved = await this.links.getCard(sourceProductId);
    if (saved === null) throw new IntegrationContractError(`Shihuo card was not saved for source product ${sourceProductId}`);
    const audiences = [...new Set(goatVariants.flatMap((variant) => variant.size.audience === undefined ? [] : [variant.size.audience]))];
    if (audiences.length !== 1) throw new IntegrationContractError(`Shihuo size audience is ambiguous for source product ${sourceProductId}`);
    return await this.cardVariants(saved.card, audiences[0]!);
  }

  private async cardVariants(card: ShihuoProductCard, audience: NonNullable<ProductVariantDTO["size"]["audience"]>): Promise<readonly ProductVariantDTO[]> {
    const bySize = new Map<string, ProductVariantDTO>();
    for (const variant of card.variants) {
      const size = variant.size?.trim().replaceAll(",", ".") ?? "";
      if (size === "" || !variant.available || variant.price === null) continue;
      const price = await this.currency.cnyToUsd(variant.price);
      const current = bySize.get(size);
      if (current !== undefined && decimalMinor(current.price!.amount)! <= decimalMinor(price)!) continue;
      bySize.set(size, {
        sourceVariantKey: `shihuo:${card.goodsId}:${card.styleId}:${variant.skuId || size}`,
        sku: variant.skuId || `${card.article}-${size}`,
        size: { sourceValue: size, displayValue: size, system: "eu-numeric", audience },
        price: { amount: price, currency: "USD" },
        inventory: { availability: "available" },
        attributes: { inventorySource: "shihuo", sourceCurrency: "CNY", sourcePrice: variant.price },
      });
    }
    return [...bySize.values()];
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function draftKey(item: JsonObject): string {
  const size = record(item.size);
  return `${String(size.taxonomy ?? "")}:${String(size.term_id ?? "")}`;
}

function available(item: JsonObject): boolean {
  return record(item.inventory).availability === "available";
}

function priceMinor(item: JsonObject): bigint | null {
  const value = record(item.price).source_minor_amount;
  return typeof value === "string" && /^\d+$/u.test(value) ? BigInt(value) : null;
}

export function mergeWordPressInventoryDrafts(goat: WordPressVariationPatchDraft, shihuo: WordPressVariationPatchDraft): WordPressVariationPatchDraft {
  const goatBySize = new Map(goat.items.map((item) => [draftKey(item), item]));
  const shihuoBySize = new Map(shihuo.items.map((item) => [draftKey(item), item]));
  const items: JsonObject[] = [];
  for (const key of new Set([...goatBySize.keys(), ...shihuoBySize.keys()])) {
    const goatItem = goatBySize.get(key);
    const shihuoItem = shihuoBySize.get(key);
    const availableItems = [goatItem, shihuoItem].filter((item): item is JsonObject => item !== undefined && available(item));
    if (availableItems.length === 0) {
      const base = goatItem ?? shihuoItem!;
      items.push({ ...base, inventory: { availability: "unavailable", quantity: 0 } });
      continue;
    }
    const selected = availableItems.reduce((lowest, item) => priceMinor(item)! < priceMinor(lowest)! ? item : lowest);
    items.push({ ...selected, inventory: record(selected.inventory) as JsonObject });
  }
  return {
    ...(goat.requiresExactSizeSet === true || shihuo.requiresExactSizeSet === true ? { requiresExactSizeSet: true } : {}),
    renamedTargetSizes: [...(goat.renamedTargetSizes ?? []), ...(shihuo.renamedTargetSizes ?? [])],
    items,
    sourceTargetSizes: [...new Set([...goat.sourceTargetSizes, ...shihuo.sourceTargetSizes])],
    knownTargetSizes: [...new Set([...goat.knownTargetSizes, ...shihuo.knownTargetSizes])],
    ignored: [...goat.ignored, ...shihuo.ignored],
    deactivateAll: goat.deactivateAll && shihuo.deactivateAll,
  };
}
