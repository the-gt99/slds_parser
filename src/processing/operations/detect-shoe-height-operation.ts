import type {
  JsonObject,
  JsonValue,
  ProductImageDTO,
  ProductOperation,
  ReferenceCandidateDTO,
  UniversalProductDTO,
} from "../../contracts/index.js";
import type { ShoeHeightClass, ShoeHeightPredictionProvider } from "../content/index.js";
import type { ImageStore } from "../media/index.js";

export interface DetectShoeHeightOperationOptions {
  readonly sourceImagePosition: number;
  readonly eligibleCategoryValues?: readonly string[];
  readonly sourceCodes?: readonly string[];
}

function titleHint(title: string): ShoeHeightClass | undefined {
  const normalized = title.toLowerCase();
  if (/\blow\b/u.test(normalized)) return "low";
  if (/\bmid\b/u.test(normalized)) return "mid";
  if (/\bhigh\b/u.test(normalized)) return "high";
  return undefined;
}

function sourceImage(images: readonly ProductImageDTO[], preferredPosition: number): ProductImageDTO | undefined {
  return images.find((image) => image.position === preferredPosition) ?? images[0];
}

function candidate(sourceValue: ShoeHeightClass, evidence: JsonObject): ReferenceCandidateDTO {
  return {
    key: "product:shoe-height",
    typeCode: "shoe_height",
    scope: "product.shoe_height",
    subjectKind: "product",
    sourceValue,
    context: {},
    evidence,
  };
}

export class DetectShoeHeightOperation implements ProductOperation {
  readonly code = "detect-shoe-height";
  readonly name = "Определение высоты обуви";
  readonly version = "1.0.0";
  readonly dependsOn = ["download-images"];
  readonly sourceCodes?: readonly string[];
  readonly configurationFingerprint: JsonValue;

  constructor(
    private readonly provider: ShoeHeightPredictionProvider,
    private readonly store: ImageStore,
    private readonly options: DetectShoeHeightOperationOptions,
  ) {
    if (!Number.isSafeInteger(options.sourceImagePosition) || options.sourceImagePosition < 0) {
      throw new Error("Shoe height source image position must be a non-negative integer");
    }
    if (options.sourceCodes !== undefined) this.sourceCodes = options.sourceCodes;
    this.configurationFingerprint = {
      provider: provider.code,
      providerVersion: provider.version,
      providerConfiguration: provider.configurationFingerprint,
      sourceImagePosition: options.sourceImagePosition,
      eligibleCategoryValues: options.eligibleCategoryValues ?? [],
    };
  }

  async execute(product: UniversalProductDTO): Promise<UniversalProductDTO> {
    if (this.options.eligibleCategoryValues !== undefined) {
      const allowed = new Set(this.options.eligibleCategoryValues.map((value) => value.toLowerCase()));
      const category = product.referenceCandidates.find((item) => item.typeCode === "category");
      if (category === undefined || !allowed.has(category.sourceValue.toLowerCase())) return product;
    }
    const image = sourceImage(product.images, this.options.sourceImagePosition);
    if (image === undefined) return product;
    if (image.localPath === undefined) throw new Error("Downloaded image local path is missing for shoe height detection");

    const prediction = await this.provider.predict(await this.store.read(image.localPath));
    const hint = titleHint(product.title);
    const finalClass = hint ?? prediction.predictedClass;
    const detection: JsonObject = {
      provider: this.provider.code,
      predictedClass: prediction.predictedClass,
      finalClass,
      sourceImagePosition: image.position,
      ...(prediction.confidence === undefined ? {} : { confidence: prediction.confidence }),
      ...(prediction.top1Index === undefined ? {} : { top1Index: prediction.top1Index }),
      ...(hint === undefined ? {} : { titleHint: hint, modelOverrideApplied: hint !== prediction.predictedClass }),
    };
    const referenceCandidates = product.referenceCandidates.filter((item) => item.key !== "product:shoe-height");

    return {
      ...product,
      referenceCandidates: [...referenceCandidates, candidate(finalClass, { title: product.title, detection })],
      attributes: { ...product.attributes, shoeHeight: finalClass },
      metadata: { ...product.metadata, shoeHeightDetection: detection },
    };
  }
}
