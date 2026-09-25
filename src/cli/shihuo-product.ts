import { createApplication } from "../bootstrap.js";
import type { ShihuoProductCard } from "../shihuo/index.js";

function sourceProductId(): string {
  const index = process.argv.indexOf("--source-product-id"); const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^\d+$/u.test(value)) throw new Error("--source-product-id must be a numeric id");
  return value;
}

function cardSummary(card: ShihuoProductCard) {
  return { article: card.article, goodsId: card.goodsId, styleId: card.styleId, title: card.title, brand: card.brand,
    model: card.model, currency: card.currency, minPrice: card.minPrice, variantCount: card.variants.length,
    availableVariantCount: card.variants.filter((variant) => variant.available).length, supplierCount: card.suppliers.length,
    attributeNames: Object.keys(card.attributes), detailUrl: card.detailUrl, httpStatus: card.httpStatus };
}

const mode = process.argv[2];
const application = createApplication();
try {
  if (!application.shihuoResolver) throw new Error("Shihuo integration is not configured");
  const id = sourceProductId();
  if (mode === "resolve") {
    const result = await application.shihuoResolver.resolveSourceProduct(id);
    console.log(JSON.stringify({ status: result.status, sourceProductId: result.sourceProductId, article: result.article,
      goodsId: result.goodsId ?? null, styleId: result.styleId ?? null,
      card: result.card === undefined ? null : cardSummary(result.card) }, null, 2));
  } else if (mode === "fetch-card") {
    console.log(JSON.stringify(cardSummary(await application.shihuoResolver.fetchResolvedProductCard({ sourceProductId: id })), null, 2));
  } else throw new Error("Expected resolve or fetch-card mode");
} catch (error) {
  const value = error instanceof Error ? { error: error.message, code: "code" in error ? String(error.code) : "SHIHUO_COMMAND_FAILED" } : { error: "Shihuo command failed", code: "SHIHUO_COMMAND_FAILED" };
  console.error(JSON.stringify(value)); process.exitCode = 1;
} finally { await application.close(); }
