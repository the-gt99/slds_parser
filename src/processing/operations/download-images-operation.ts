import type {
  JsonValue,
  ProductImageDTO,
  ProductOperation,
  ProductOperationContext,
  UniversalProductDTO,
} from "../../contracts/index.js";
import type { ImageBinaryDownloader, ImageStore } from "../media/index.js";
import { fulfilledOrThrow, settleWithConcurrency } from "./media-operation-support.js";

export interface DownloadImagesOperationOptions {
  readonly concurrency: number;
  readonly sourceCodes?: readonly string[];
}

export class DownloadImagesOperation implements ProductOperation {
  readonly code = "download-images";
  readonly version = "1.0.0";
  readonly dependsOn = ["normalize-product"];
  readonly sourceCodes?: readonly string[];
  readonly configurationFingerprint: JsonValue;

  constructor(
    private readonly downloader: ImageBinaryDownloader,
    private readonly store: ImageStore,
    private readonly options: DownloadImagesOperationOptions,
  ) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error("Image download concurrency must be a positive integer");
    if (options.sourceCodes !== undefined) this.sourceCodes = options.sourceCodes;
    this.configurationFingerprint = {
      concurrency: options.concurrency,
      downloader: downloader.code,
      downloaderVersion: downloader.version,
      store: store.fingerprint(),
    };
  }

  async execute(
    product: UniversalProductDTO,
    context: ProductOperationContext,
  ): Promise<UniversalProductDTO> {
    const results = await settleWithConcurrency(product.images, this.options.concurrency, async (image): Promise<ProductImageDTO> => {
      const sourceUrl = image.sourceUrl ?? image.url;
      const binary = await this.downloader.download(sourceUrl, context);
      const asset = await this.store.storeOriginal(context.source.code, product.sourceProductId, image.position, binary);
      return {
        ...image,
        sourceUrl,
        localPath: asset.localPath,
        mimeType: asset.mimeType,
        storedFormat: asset.storedFormat,
        width: asset.width,
        height: asset.height,
      };
    });
    return { ...product, images: fulfilledOrThrow(results, "Product images are empty") };
  }
}
