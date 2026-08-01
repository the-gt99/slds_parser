import type {
  CollectedSourceProduct,
  CollectProductInput,
  DiscoveryInput,
  DiscoveryResult,
  ExportContext,
  ExportResult,
  ProcessingContext,
  UniversalProductDTO,
} from "./products.js";

export interface SourceAdapter {
  readonly code: string;
  readonly version: string;
  discover(input: DiscoveryInput): Promise<DiscoveryResult>;
  collectProduct(input: CollectProductInput): Promise<CollectedSourceProduct>;
}

export interface SourceProcessor {
  readonly sourceCode: string;
  readonly version: string;
  process(context: ProcessingContext): Promise<UniversalProductDTO>;
}

export interface TargetExporter {
  readonly targetCode: string;
  readonly version: string;
  export(context: ExportContext): Promise<ExportResult>;
}
