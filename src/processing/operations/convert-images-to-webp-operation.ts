import type {
  JsonValue,
  ProductImageDTO,
  ProductOperation,
  UniversalProductDTO,
} from "../../contracts/index.js";
import type { ImageStore } from "../media/index.js";
import { imageContentHash, imagePerceptualHash } from "../media/index.js";
import { fulfilledOrThrow, settleWithConcurrency } from "./media-operation-support.js";

export interface ConvertImagesToWebpOperationOptions {
  readonly concurrency: number;
  readonly sourceCodes?: readonly string[];
}

export class ConvertImagesToWebpOperation implements ProductOperation {
  readonly code = "convert-images-to-webp";
  readonly name = "Конвертация изображений в WEBP";
  readonly version = "1.2.0";
  readonly dependsOn = ["download-images"];
  readonly sourceCodes?: readonly string[];
  readonly configurationFingerprint: JsonValue;

  constructor(
    private readonly store: ImageStore,
    private readonly options: ConvertImagesToWebpOperationOptions,
  ) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error("Image conversion concurrency must be a positive integer");
    if (options.sourceCodes !== undefined) this.sourceCodes = options.sourceCodes;
    this.configurationFingerprint = { concurrency: options.concurrency, store: store.fingerprint() };
  }

  async execute(product: UniversalProductDTO): Promise<UniversalProductDTO> {
    if (product.images.length === 0) return product;
    const results = await settleWithConcurrency(product.images, this.options.concurrency, async (image): Promise<ProductImageDTO> => {
      if (image.localPath === undefined) throw new Error("Downloaded image local path is missing");
      const webpLocalPath = await this.store.convertToWebp(image.localPath);
      const binary = await this.store.read(webpLocalPath);
      return {
        ...image,
        localPath: webpLocalPath,
        webpLocalPath,
        mimeType: "image/webp",
        storedFormat: "webp",
        contentHash: imageContentHash(binary),
        perceptualHash: await imagePerceptualHash(binary),
      };
    });
    return { ...product, images: fulfilledOrThrow(results, "Downloaded product images are empty") };
  }
}
