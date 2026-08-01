import type { JsonValue, ProductOperation, UniversalProductDTO } from "../../contracts/index.js";
import type { ImageStore } from "../media/index.js";

export class PublishImagesOperation implements ProductOperation {
  readonly code = "publish-images";
  readonly version = "1.0.0";
  readonly dependsOn = ["convert-images-to-webp"];
  readonly sourceCodes?: readonly string[];
  readonly configurationFingerprint: JsonValue;

  constructor(private readonly store: ImageStore, sourceCodes?: readonly string[]) {
    if (sourceCodes !== undefined) this.sourceCodes = sourceCodes;
    this.configurationFingerprint = { store: store.fingerprint() };
  }

  async execute(product: UniversalProductDTO): Promise<UniversalProductDTO> {
    return {
      ...product,
      images: product.images.map((image) => {
        if (image.webpLocalPath === undefined) throw new Error("Processed image WebP path is missing");
        return { ...image, url: this.store.publicUrl(image.webpLocalPath) };
      }),
    };
  }
}
