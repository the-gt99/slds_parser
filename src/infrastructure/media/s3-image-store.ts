import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { posix } from "node:path";

import type { ImageStore, StoredImageAsset } from "../../processing/media/index.js";
import { LocalImageStore, type LocalImageStoreOptions } from "./local-image-store.js";

export interface S3ImageStoreOptions extends LocalImageStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface ObjectStorageClient {
  send(command: PutObjectCommand): Promise<unknown>;
}

function objectKey(prefix: string | undefined, localPath: string): string {
  const normalizedPrefix = (prefix ?? "").trim().replace(/^\/+|\/+$/gu, "");
  const normalizedPath = localPath.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalizedPrefix === "" ? normalizedPath : posix.join(normalizedPrefix, normalizedPath);
}

export class S3ImageStore implements ImageStore {
  readonly #local: LocalImageStore;
  readonly #client: ObjectStorageClient;

  constructor(private readonly options: S3ImageStoreOptions, client?: ObjectStorageClient) {
    this.#local = new LocalImageStore(options);
    this.#client = client ?? new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  fingerprint(): Record<string, string | number> {
    return {
      ...this.#local.fingerprint(),
      storage: "s3",
      endpoint: this.options.endpoint,
      region: this.options.region,
      bucket: this.options.bucket,
    };
  }

  async read(localPath: string): Promise<Buffer> {
    return await this.#local.read(localPath);
  }

  async storeOriginal(
    sourceCode: string,
    sourceProductId: string,
    position: number,
    binary: Buffer,
  ): Promise<StoredImageAsset> {
    return await this.#local.storeOriginal(sourceCode, sourceProductId, position, binary);
  }

  async convertToWebp(localPath: string): Promise<string> {
    return await this.#local.convertToWebp(localPath);
  }

  publicUrl(localPath: string): string {
    return this.#local.publicUrl(localPath);
  }

  async publish(localPath: string): Promise<string> {
    const body = await this.read(localPath);
    await this.#client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey(this.options.publicPathPrefix, localPath),
      Body: body,
      ContentLength: body.length,
      ContentType: "image/webp",
    }));
    return this.publicUrl(localPath);
  }
}
