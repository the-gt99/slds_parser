import type {
  CollectedSourceProduct,
  CollectProductInput,
  DiscoveryInput,
  DiscoveryResult,
  ExportContext,
  ExportResult,
  JsonValue,
  ProcessingContext,
  ProductOperationContext,
  UniversalProductDTO,
} from "./products.js";

export interface SourceAdapter {
  readonly code: string;
  readonly version: string;
  /** Source parts that must be refreshed and reprocessed before a target write. */
  readonly exportRefreshPartKeys?: readonly string[];
  discover(input: DiscoveryInput): Promise<DiscoveryResult>;
  collectProduct(input: CollectProductInput): Promise<CollectedSourceProduct>;
}

export interface SourceProcessor {
  readonly sourceCode: string;
  readonly version: string;
  /** Version of reference-candidate extraction used to filter classifier observations. */
  readonly classificationVersion: string;
  process(context: ProcessingContext): Promise<UniversalProductDTO>;
}

export interface ProductOperation {
  readonly code: string;
  readonly name?: string;
  readonly version: string;
  /** Dependencies must be registered earlier and apply to the same source. */
  readonly dependsOn?: readonly string[];
  /** Omit to run the operation for every source. */
  readonly sourceCodes?: readonly string[];
  /** Non-secret settings that affect the result and must invalidate cached processing. */
  readonly configurationFingerprint?: JsonValue;
  execute(
    product: UniversalProductDTO,
    context: ProductOperationContext,
  ): Promise<UniversalProductDTO>;
}

export interface TargetExporter {
  readonly targetCode: string;
  readonly version: string;
  export(context: ExportContext): Promise<ExportResult>;
}
