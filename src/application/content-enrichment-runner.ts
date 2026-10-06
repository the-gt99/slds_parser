import type { UniversalProductDTO } from "../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError, RetryableError } from "../core/errors/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type { InternalProductRepository } from "../repositories/index.js";
import type { ContentEnrichmentRecord, ContentEnrichmentRepository } from "../repositories/content-enrichment-repository.js";
import type { TextTranslationProvider } from "../processing/content/index.js";
import { applyMissingDescription, hasDescription } from "../processing/operations/apply-content-enrichment-operation.js";
import type { RunnerResult } from "./runner-result.js";

export interface ProductContentDonor {
  readonly code: string;
  collect(product: UniversalProductDTO, options?: { readonly resolveIfMissing: boolean }): Promise<Omit<ContentEnrichmentRecord,"id"|"status"|"translatedText"> & {
    readonly status: "collected" | "skipped";
  }>;
  validate(product: UniversalProductDTO, record: ContentEnrichmentRecord): Promise<boolean>;
}

export class ContentEnrichmentRunner {
  constructor(private readonly products: InternalProductRepository, private readonly repository: ContentEnrichmentRepository,
    private readonly donors: ReadonlyMap<string, ProductContentDonor>, private readonly translation: TextTranslationProvider) {}
  async collect(payload: { readonly sourceProductId: string; readonly donorCode: string; readonly resolveIfMissing?: boolean }): Promise<RunnerResult> {
    const product = await this.products.findBySourceProductId(payload.sourceProductId);
    if (!product) throw new EntityNotFoundError("Internal product", payload.sourceProductId);
    if (hasDescription(product.data)) return { status: "skipped" };
    const donor = this.donors.get(payload.donorCode);
    if (!donor) throw new IntegrationContractError("Content donor is not configured");
    const record = payload.resolveIfMissing === true
      ? await donor.collect(product.data,{ resolveIfMissing: true }) : await donor.collect(product.data);
    await this.repository.save(record);
    return { status: record.status === "skipped" ? "skipped" : "completed" };
  }
  async translate(payload: { readonly sourceProductId: string; readonly enrichmentId: string }): Promise<RunnerResult> {
    const record = await this.repository.get(payload.enrichmentId);
    if (!record || record.sourceProductId !== payload.sourceProductId) throw new IntegrationContractError("Content enrichment identity mismatch");
    if (record.status !== "collected") return { status: "skipped" };
    const current = await this.products.findBySourceProductId(payload.sourceProductId);
    if (!current) throw new EntityNotFoundError("Internal product", payload.sourceProductId);
    const donor = this.donors.get(record.donorCode);
    if (hasDescription(current.data) || !donor || !await donor.validate(current.data,record)) {
      await this.repository.skip(record.id,"content_or_identity_changed"); return { status: "skipped" };
    }
    const translated = (await this.translation.translate(record.cleanedText,record.sourceLocale,record.targetLocale)).trim();
    if (translated === "" || !/[А-Яа-яЁё]/u.test(translated) || /[\p{Script=Han}]/u.test(translated)
      || /(?:\bCNY\b|юан|Dewu|天猫|京东|得物|最低价|可选配色|全网价格区间)/iu.test(translated)) {
      throw new IntegrationContractError("Content enrichment translation contains untranslated or dynamic data");
    }
    // Re-read after the external call: classification and source processing can run concurrently.
    const latest = await this.products.findBySourceProductId(payload.sourceProductId);
    if (!latest || hasDescription(latest.data) || !await donor.validate(latest.data,record)) {
      await this.repository.skip(record.id,"content_or_identity_changed"); return { status: "skipped" };
    }
    const data = applyMissingDescription(latest.data,record,translated);
    if (data === latest.data) { await this.repository.skip(record.id,"article_changed"); return { status: "skipped" }; }
    if (!await this.repository.apply({ enrichmentId: record.id, internalProductId: latest.id,
      expectedContentHash: latest.contentHash, data, contentHash: hashStableJson(data as never), translatedText: translated })) {
      throw new RetryableError("Product changed while applying content enrichment", { code: "CONTENT_ENRICHMENT_CONFLICT" });
    }
    return { status: "completed" };
  }
}
