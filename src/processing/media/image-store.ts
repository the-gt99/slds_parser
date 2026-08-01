export interface StoredImageAsset {
  readonly localPath: string;
  readonly mimeType: string;
  readonly storedFormat: string;
  readonly width: number;
  readonly height: number;
}

export interface ImageStore {
  fingerprint(): Record<string, string | number>;
  storeOriginal(
    sourceCode: string,
    sourceProductId: string,
    position: number,
    binary: Buffer,
  ): Promise<StoredImageAsset>;
  convertToWebp(localPath: string): Promise<string>;
  publicUrl(localPath: string): string;
}
