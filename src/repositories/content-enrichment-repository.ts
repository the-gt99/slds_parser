import type { JsonObject, UniversalProductDTO } from "../contracts/index.js";

export interface ContentEnrichmentRecord {
  readonly id: string;
  readonly sourceProductId: string;
  readonly donorCode: string;
  readonly donorProductKey: string;
  readonly article: string;
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly parserVersion: string;
  readonly rawPayload: JsonObject;
  readonly cleanedText: string;
  readonly translatedText: string | null;
  readonly status: "collected" | "applied" | "skipped";
  readonly reason: string | null;
}

export interface ContentEnrichmentRepository {
  get(id: string): Promise<ContentEnrichmentRecord | null>;
  latestApplied(sourceProductId: string): Promise<ContentEnrichmentRecord | null>;
  save(input: Omit<ContentEnrichmentRecord, "id" | "translatedText" | "status"> & {
    readonly status: "collected" | "skipped";
  }): Promise<ContentEnrichmentRecord>;
  skip(id: string, reason: string): Promise<void>;
  apply(input: { readonly enrichmentId: string; readonly internalProductId: string;
    readonly expectedContentHash: string; readonly data: UniversalProductDTO;
    readonly contentHash: string; readonly translatedText: string }): Promise<boolean>;
}
