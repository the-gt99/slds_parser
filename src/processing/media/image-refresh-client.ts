export interface ImageValidators {
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface ImageDownload extends ImageValidators {
  readonly body: Buffer;
}

export interface ImageRefreshClient {
  /** Conditional GET stopped after final headers; never intentionally downloads the body. */
  inspect(url: string, validators: ImageValidators): Promise<ImageValidators & { readonly unchanged: boolean }>;
  downloadImage(url: string): Promise<ImageDownload>;
}
