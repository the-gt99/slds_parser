import type {
  CollectedSourceProduct,
  DiscoveryResult,
  ExportResult,
  SourceProductReference,
  UniversalProductDTO,
} from "./products.js";

export interface SourceAdapter {
  readonly version: string;
  discover(): Promise<DiscoveryResult>;
  collectProduct(
    reference: SourceProductReference,
  ): Promise<CollectedSourceProduct>;
}

export interface SourceProcessor {
  readonly version: string;
  process(product: CollectedSourceProduct): Promise<UniversalProductDTO>;
}

export interface TargetExporter {
  readonly version: string;
  export(product: UniversalProductDTO): Promise<ExportResult>;
}
