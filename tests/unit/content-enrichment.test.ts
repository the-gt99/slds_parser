import { describe, expect, it, vi } from "vitest";
import type { UniversalProductDTO } from "../../src/contracts/index.js";
import { cleanShihuoDescription, descriptionIdentityMatches, ShihuoDescriptionDonor } from "../../src/shihuo/description-donor.js";
import { parseCollectProductContentPayload } from "../../src/application/job-payloads.js";
import type { ShihuoProductCard } from "../../src/shihuo/product-types.js";
import type { ContentEnrichmentRecord, ContentEnrichmentRepository } from "../../src/repositories/content-enrichment-repository.js";
import { ApplyContentEnrichmentOperation, applyMissingDescription } from "../../src/processing/operations/apply-content-enrichment-operation.js";
import { ContentEnrichmentRunner, type ProductContentDonor } from "../../src/application/content-enrichment-runner.js";
import { TranslateContentOperation } from "../../src/processing/index.js";
import { createMemoryRepositories, MemoryStore, seedProduct, validProduct } from "../support/in-memory.js";

const product: UniversalProductDTO = { ...validProduct(),title: "Nike ACG Mountain Fly 'Khaki'",description: "",sku: "CT2904-200",
  attributes: { brand: "Nike",family: "ACG Mountain Fly",color: "black" } };
const properties = [{ name: "货号",value: "CT2904-200" },{ name: "球鞋配置",value: "React、缓震" },
  { name: "发售日期",value: "2020.11.12" },{ name: "球星同款",value: "某球星" }];
const description = "商品名称：综合营销标题。可选配色：黑色、白色。可选尺码：40、41。全网价格区间：1530元（Dewu最低价）。在功能配置方面，货号为CT2904-200，球鞋配置为React、缓震，发售日期为2020.11.12，球星同款为某球星。";
const card: ShihuoProductCard = { goodsId: "1",styleId: "2",article: "CT2904-200",brand: "Nike/耐克",model: "ACG Mountain Fly",
  title: "Nike ACG Mountain Fly",currency: "CNY",minPrice: "1530",variants: [],suppliers: [],attributes: { 货号: ["CT2904-200"] },
  detailUrl: "https://www.shihuo.cn/page/pcGoodsDetail?goodsId=1&styleId=2",httpStatus: 200,
  structuredProduct: { description,additionalProperty: properties } };
const record: ContentEnrichmentRecord = { id: "1",sourceProductId: "2",donorCode: "shihuo",donorProductKey: "1:2",article: "CT2904-200",
  sourceLocale: "zh-CN",targetLocale: "ru",parserVersion: "1.0.0",rawPayload: {},cleanedText: "球鞋配置：React、缓震。",translatedText: null,
  status: "collected",reason: null };
const russian = "Nike ACG Mountain Fly Khaki. Артикул: CT2904-200. Технологии: React, амортизация.";
function repository(): ContentEnrichmentRepository {
  return { get: vi.fn(async () => record),latestApplied: vi.fn(async () => ({ ...record,status: "applied" as const,translatedText: russian })),
    save: vi.fn(async () => record),skip: vi.fn(async () => {}),apply: vi.fn(async () => true) };
}
describe("Shihuo description cleaning", () => {
  it("requires an explicit boolean before searching for an unlinked product", () => {
    expect(parseCollectProductContentPayload({ sourceProductId: "2",donorCode: "shihuo",resolveIfMissing: true }).resolveIfMissing).toBe(true);
    expect(() => parseCollectProductContentPayload({ sourceProductId: "2",donorCode: "shihuo",resolveIfMissing: "yes" })).toThrow();
  });
  it("searches once when requested and reuses the freshly confirmed card", async () => {
    const links = { get: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ status: "resolved",goodsId: "1",styleId: "2",sourceArticle: product.sku }) };
    const resolver = { resolveSourceProduct: vi.fn().mockResolvedValue({ status: "resolved",card }),fetchResolvedProductCard: vi.fn() };
    const donor = new ShihuoDescriptionDonor(resolver as never,links as never,"ru");
    expect((await donor.collect(product,{ resolveIfMissing: true })).status).toBe("collected");
    expect(resolver.resolveSourceProduct).toHaveBeenCalledOnce();
    expect(resolver.fetchResolvedProductCard).not.toHaveBeenCalled();
  });
  it("does not search existing links or invent a description for a missing match", async () => {
    const resolver = { resolveSourceProduct: vi.fn().mockResolvedValue({ status: "not_found" }),fetchResolvedProductCard: vi.fn().mockResolvedValue(card) };
    const links = { get: vi.fn().mockResolvedValue(null) };
    const donor = new ShihuoDescriptionDonor(resolver as never,links as never,"ru");
    expect((await donor.collect(product)).reason).toBe("unconfirmed_link");
    expect(resolver.resolveSourceProduct).not.toHaveBeenCalled();
    expect((await donor.collect(product,{ resolveIfMissing: true })).reason).toBe("resolution_not_found");
    links.get.mockResolvedValue({ status: "resolved",goodsId: "1",styleId: "2",sourceArticle: product.sku });
    await donor.collect(product,{ resolveIfMissing: true });
    expect(resolver.resolveSourceProduct).toHaveBeenCalledOnce();
  });
  it("keeps verified features and the exact catalog title, excluding prices, palettes, sizes and unrelated metadata", () => {
    const result = cleanShihuoDescription(product,card);
    expect(result.reason).toBeNull();
    expect(result.text).toContain(product.title);
    expect(result.text).toContain("球鞋配置：React、缓震");
    for (const excluded of ["Dewu","1530","最低价","可选配色","可选尺码","2020.11.12","某球星","综合营销标题"]) expect(result.text).not.toContain(excluded);
  });
  it.each([
    [description.replace("可选尺码", "未知尺码"),"description_template_unknown"],
    [description + "可选配色：其他", "description_template_unknown"],
    [description + "最低价为20元", "dynamic_tail"],
  ])("rejects unknown or dynamic templates", (text,reason) => {
    expect(cleanShihuoDescription(product,{ ...card,structuredProduct: { description: text,additionalProperty: properties } }).reason).toBe(reason);
  });
  it("rejects wrong or aggregated articles and conflicting stud types", () => {
    expect(cleanShihuoDescription({ ...product,sku: "OTHER" },card).reason).toBe("description_article_mismatch");
    expect(cleanShihuoDescription(product,{ ...card,structuredProduct: { description,additionalProperty: [...properties,properties[0]!] } }).reason).toBe("description_article_mismatch");
    expect(cleanShihuoDescription(product,{ ...card,structuredProduct: { description: description + "鞋钉类型为AG、FG。",
      additionalProperty: [...properties,{ name: "鞋钉类型",value: "AG、FG" }] } }).reason).toBe("ambiguous_stud_types");
  });
  it("requires a feature besides the article", () => {
    expect(cleanShihuoDescription(product,{ ...card,structuredProduct: { description,additionalProperty: [properties[0]!] } }).reason).toBe("no_product_features");
  });
  it("checks brand, family and one exact article only for description enrichment", () => {
    expect(descriptionIdentityMatches(product,card)).toBe(true);
    expect(descriptionIdentityMatches(product,{ ...card,brand: "adidas" })).toBe(false);
    expect(descriptionIdentityMatches(product,{ ...card,title: "Nike wallet",model: "wallet" })).toBe(false);
    expect(descriptionIdentityMatches(product,{ ...card,attributes: { 货号: ["CT2904-200","OTHER"] } })).toBe(false);
    expect(descriptionIdentityMatches({ ...product,attributes: { brand: "Nike" } },card)).toBe(false);
  });
});
describe("content enrichment", () => {
  it("does not overwrite raw, translated or story descriptions", () => {
    for (const p of [{ ...product,description: "Existing" },{ ...product,attributes: { story: "Existing" } },
      { ...product,translatedContent: { sourceLocale: "en",targetLocale: "ru",description: "Есть",story: "",color: "",details: "",upperMaterial: "" } }]) {
      expect(applyMissingDescription(p,record,russian)).toBe(p);
    }
    expect(applyMissingDescription({ ...product,sku: "OTHER" },record,russian).description).toBe("");
  });
  it("restores only applied, still validated enrichment during processing", async () => {
    const repo = repository();
    const valid = new ApplyContentEnrichmentOperation(repo,async () => true);
    const data = await valid.execute(product);
    expect(data.description).toBe(record.cleanedText);
    expect(data.images).toBe(product.images);
    expect(data.variants).toBe(product.variants);
    expect(data.referenceCandidates).toBe(product.referenceCandidates);
    expect(await new ApplyContentEnrichmentOperation(repo,async () => false).execute(product)).toBe(product);
  });
  it("translates donated description from Chinese without changing the locale of source attributes", async () => {
    const data = applyMissingDescription(product,record,russian);
    const translate = vi.fn(async () => russian);
    const result = await new TranslateContentOperation({ code: "test",version: "1",translate },{ sourceLocale: "en",targetLocale: "ru" }).execute(data);
    expect(translate).toHaveBeenCalledWith(record.cleanedText,"zh-CN","ru");
    expect(result.translatedContent?.color).toBe("Черный");
    expect(result.translatedContent?.sourceLocale).toBe("en");
  });
  async function setup() {
    const store = new MemoryStore(); seedProduct(store);
    const products = createMemoryRepositories(store).internalProducts;
    await products.upsert({ sourceProductId: "2",data: product,inputHash: "input",contentHash: "before",processorVersion: "1",status: "classified" });
    const repo = repository();
    const donor: ProductContentDonor = { code: "shihuo",collect: vi.fn(async () => ({ ...record,status: "collected" as const })),validate: vi.fn(async () => true) };
    const translate = vi.fn(async () => russian);
    return { repo,donor,translate,runner: new ContentEnrichmentRunner(products,repo,new Map([[donor.code,donor]]),{ code: "test",version: "1",translate }) };
  }
  it("saves collected content separately and applies with a content-hash guard", async () => {
    const s = await setup();
    await s.runner.collect({ sourceProductId: "2",donorCode: "shihuo" });
    expect(s.repo.save).toHaveBeenCalledWith(record);
    expect(s.translate).not.toHaveBeenCalled();
    await expect(s.runner.translate({ sourceProductId: "2",enrichmentId: "1" })).resolves.toEqual({ status: "completed" });
    expect(s.repo.apply).toHaveBeenCalledWith(expect.objectContaining({ expectedContentHash: "before",translatedText: russian }));
  });
  it("checks the live target before searching and skips existing products", async () => {
    const s = await setup();
    const store = new MemoryStore(); seedProduct(store);
    const products = createMemoryRepositories(store).internalProducts;
    await products.upsert({ sourceProductId: "2",data: product,inputHash: "input",contentHash: "before",processorVersion: "1",status: "classified" });
    const eligible = vi.fn(async () => false);
    const runner = new ContentEnrichmentRunner(products,s.repo,new Map([[s.donor.code,s.donor]]),{ code: "test",version: "1",translate: s.translate },eligible);
    expect(await runner.collect({ sourceProductId: "2",donorCode: "shihuo",resolveIfMissing: true,newProductTargetId: "1" })).toEqual({ status: "skipped" });
    expect(eligible).toHaveBeenCalledWith("2","1");
    expect(s.donor.collect).not.toHaveBeenCalled();
    eligible.mockResolvedValue(true);
    await runner.collect({ sourceProductId: "2",donorCode: "shihuo",resolveIfMissing: true,newProductTargetId: "1" });
    expect(s.donor.collect).toHaveBeenCalledWith(product,{ resolveIfMissing: true });
  });
  it("rechecks identity after translation and leaves a revoked link untouched", async () => {
    const s = await setup(); vi.mocked(s.donor.validate).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await s.runner.translate({ sourceProductId: "2",enrichmentId: "1" })).toEqual({ status: "skipped" });
    expect(s.repo.apply).not.toHaveBeenCalled(); expect(s.repo.skip).toHaveBeenCalled();
  });
  it.each(["中文未翻译","Цена: 1530 юаней","Амортизация React 中文", ""])("rejects unsafe translations", async (text) => {
    const s = await setup(); s.translate.mockResolvedValue(text);
    await expect(s.runner.translate({ sourceProductId: "2",enrichmentId: "1" })).rejects.toThrow(/translation/);
    expect(s.repo.apply).not.toHaveBeenCalled();
  });
  it("retries a concurrent product change and skips already applied records", async () => {
    const s = await setup(); vi.mocked(s.repo.apply).mockResolvedValue(false);
    await expect(s.runner.translate({ sourceProductId: "2",enrichmentId: "1" })).rejects.toThrow(/changed/);
    vi.mocked(s.repo.get).mockResolvedValue({ ...record,status: "applied" });
    expect(await s.runner.translate({ sourceProductId: "2",enrichmentId: "1" })).toEqual({ status: "skipped" });
  });
});
