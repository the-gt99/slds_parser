export interface StoredImageAsset {
  readonly localPath: string;
  readonly mimeType: string;
  readonly storedFormat: string;
  readonly width: number;
  readonly height: number;
}

export interface ImageStore {
  fingerprint(): Record<string, string | number>;
  read(localPath: string): Promise<Buffer>;
  storeOriginal(
    sourceCode: string,
    sourceProductId: string,
    position: number,
    binary: Buffer,
  ): Promise<StoredImageAsset>;
  convertToWebp(localPath: string): Promise<string>;
  publicUrl(localPath: string): string;
  publish(localPath: string): Promise<string>;
}
