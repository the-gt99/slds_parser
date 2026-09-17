import { GetObjectCommand, PutObjectCommand, S3Client, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { rename, rm } from "node:fs/promises";
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
  send(command: PutObjectCommand | GetObjectCommand): Promise<unknown>;
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
      storageVersion: 2,
      endpoint: this.options.endpoint,
      region: this.options.region,
      bucket: this.options.bucket,
    };
  }

  async read(localPath: string): Promise<Buffer> {
    // A published asset lives in object storage; the local file is only a staging copy.
    try {
      return await this.#local.read(localPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const result = await this.#client.send(new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey(this.options.publicPathPrefix, localPath),
    })) as GetObjectCommandOutput;
    if (result.Body === undefined) throw new Error("Stored image body is missing");
    const binary = Buffer.from(await result.Body.transformToByteArray());
    if (result.ContentLength !== undefined && binary.length !== result.ContentLength) {
      throw new Error("Stored image is incomplete");
    }
    const expectedHash = /\.([a-f0-9]{64})\.webp$/u.exec(localPath)?.[1];
    if (expectedHash !== undefined && createHash("sha256").update(binary).digest("hex") !== expectedHash) {
      throw new Error("Stored image checksum does not match its path");
    }
    return binary;
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
    if (/\.[a-f0-9]{64}\.webp$/u.test(localPath)) {
      await this.read(localPath);
      return localPath;
    }
    const converted = await this.#local.convertToWebp(localPath);
    const binary = await this.#local.read(converted);
    const hash = createHash("sha256").update(binary).digest("hex");
    const immutablePath = converted.slice(0, -5) + `.${hash}.webp`;
    await rename(this.#local.resolvePath(converted), this.#local.resolvePath(immutablePath));
    return immutablePath;
  }

  publicUrl(localPath: string): string {
    return this.#local.publicUrl(localPath);
  }

  async publish(localPath: string): Promise<string> {
    const body = await this.read(localPath);
    const expectedHash = /\.([a-f0-9]{64})\.webp$/u.exec(localPath)?.[1];
    if (expectedHash !== createHash("sha256").update(body).digest("hex")) {
      throw new Error("Published image must use its content checksum in the path");
    }
    await this.#client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey(this.options.publicPathPrefix, localPath),
      Body: body,
      ContentLength: body.length,
      ContentType: "image/webp",
      ContentMD5: createHash("md5").update(body).digest("base64"),
      CacheControl: "public, max-age=31536000, immutable",
    }));
    await rm(this.#local.resolvePath(localPath), { force: true });
    return this.publicUrl(localPath);
  }
}
