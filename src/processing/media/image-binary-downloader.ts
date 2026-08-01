import type { ProductOperationContext } from "../../contracts/index.js";

export interface ImageBinaryDownloader {
  readonly code: string;
  readonly version: string;
  download(url: string, context: ProductOperationContext): Promise<Buffer>;
}
