import type { ProductOperation, UniversalProductDTO } from "../../contracts/index.js";
import type { ContentEnrichmentRecord, ContentEnrichmentRepository } from "../../repositories/content-enrichment-repository.js";

export function hasDescription(product: UniversalProductDTO): boolean {
  return [product.description, product.attributes.story, product.translatedContent?.description, product.translatedContent?.story]
    .some((value) => typeof value === "string" && value.trim() !== "");
}

export function applyMissingDescription(product: UniversalProductDTO, enrichment: ContentEnrichmentRecord,
  translatedText = enrichment.translatedText): UniversalProductDTO {
  if (hasDescription(product) || translatedText === null || product.sku?.trim() !== enrichment.article.trim()) return product;
  return { ...product, description: enrichment.cleanedText,
    translatedContent: { ...(product.translatedContent ?? { sourceLocale: enrichment.sourceLocale, targetLocale: enrichment.targetLocale,
      story: "", color: "", details: "", upperMaterial: "" }),
      description: translatedText },
    metadata: { ...product.metadata, contentProvenance: { description: {
      enrichmentId: enrichment.id, donorCode: enrichment.donorCode, donorProductKey: enrichment.donorProductKey,
      sourceLocale: enrichment.sourceLocale, targetLocale: enrichment.targetLocale, parserVersion: enrichment.parserVersion,
    } } } };
}

export class ApplyContentEnrichmentOperation implements ProductOperation {
  readonly code = "apply-content-enrichment";
  readonly name = "Дополнение отсутствующего описания";
  readonly version = "1.0.0";
  readonly dependsOn = ["normalize-product"];
  constructor(private readonly repository: ContentEnrichmentRepository,
    private readonly validate: (product: UniversalProductDTO, record: ContentEnrichmentRecord) => Promise<boolean>) {}
  async execute(product: UniversalProductDTO): Promise<UniversalProductDTO> {
    if (hasDescription(product)) return product;
    const record = await this.repository.latestApplied(product.sourceProductId);
    return record === null || !await this.validate(product,record) ? product : applyMissingDescription(product, record);
  }
}
