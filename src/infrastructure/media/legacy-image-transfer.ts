import { createHash } from "node:crypto";
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { GetObjectCommand, PutObjectCommand, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import type { ObjectStorageClient, S3ImageStoreOptions } from "./s3-image-store.js";
import type { ImageMirrorQueue } from "./image-mirror.js";

const checksum = (body: Buffer): string => createHash("sha256").update(body).digest("hex");

export function nextLegacyFailedBatchCount(previous: number, outcomes: readonly { result: unknown | null }[]): number {
  return outcomes.length > 0 && outcomes.every((entry) => entry.result === null) ? previous + 1 : 0;
}

export function legacyImageFailure(error: unknown) {
  const value = error as { name?: unknown; code?: unknown; status?: unknown;
    $metadata?: { httpStatusCode?: unknown }; cause?: { code?: unknown } } | null;
  const safeCode = (code: unknown) => typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(code) ? code : undefined;
  const status = value?.$metadata?.httpStatusCode ?? value?.status;
  return { name: safeCode(value?.name) ?? "Error", code: safeCode(value?.code ?? value?.cause?.code),
    status: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined };
}

export async function transferLegacyImageBatch(transfer: Pick<LegacyImageTransfer, "transfer">,
  paths: readonly string[], minimumAgeMs: number) {
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate paths in image transfer batch");
  return Promise.all(paths.map(async (path) => {
    try { return { path, result: await transfer.transfer(path, minimumAgeMs) }; }
    catch (error) { return { path, result: null, failure: legacyImageFailure(error) }; }
  }));
}

// Administrative transfer preserves legacy keys and URLs; normal publication stays immutable.
export class LegacyImageTransfer {
  constructor(private readonly options: S3ImageStoreOptions,
    private readonly client: ObjectStorageClient, private readonly fetchImpl: typeof fetch = fetch,
    private readonly mirror?: ImageMirrorQueue) {}

  async transfer(relativePath: string, minimumAgeMs: number): Promise<{ deletedBytes: number; uploaded: boolean; skipped: boolean }> {
    if (!/^[a-zA-Z0-9_-]+\/item_[a-zA-Z0-9_-]+\/\d+(?:-main)?(?:\.[a-f0-9]{64})?\.webp$/u.test(relativePath)) {
      throw new Error("Unsupported legacy image path");
    }
    const root = await realpath(this.options.baseDirectory);
    const path = resolve(root, relativePath);
    if (!path.startsWith(`${root}${sep}`)) throw new Error("Image leaves storage directory");
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || await realpath(path) !== path) throw new Error("Image is not a regular storage file");
    if (before.size > 20 * 1024 * 1024) throw new Error("Image exceeds transfer memory limit; retained");
    if (minimumAgeMs > 0 && Date.now() - before.mtimeMs < minimumAgeMs) return { deletedBytes: 0, uploaded: false, skipped: true };
    const body = await readFile(path);
    if (body.subarray(0, 4).toString() !== "RIFF" || body.subarray(8, 12).toString() !== "WEBP") throw new Error("Invalid WebP header");
    const hash = checksum(body);
    const pathHash = /\.([a-f0-9]{64})\.webp$/u.exec(relativePath)?.[1];
    if (pathHash !== undefined && hash !== pathHash) throw new Error("Image path checksum mismatch");
    const prefix = (this.options.publicPathPrefix ?? "").replace(/^\/+|\/+$/gu, "");
    const key = prefix ? `${prefix}/${relativePath}` : relativePath;
    let uploaded = false;
    let remote = await this.remote(key);
    if (remote !== null && checksum(remote) !== hash) throw new Error("Object storage copy differs; local file retained");
    await this.mirror?.enqueue({ key, sha256: hash, size: body.length });
    if (remote === null) {
      await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: body,
        ContentLength: body.length, ContentType: "image/webp", IfNoneMatch: "*",
        ContentMD5: createHash("md5").update(body).digest("base64"), Metadata: { sha256: hash },
        CacheControl: pathHash === undefined ? "public, max-age=3600" : "public, max-age=31536000, immutable" }));
      uploaded = true;
      remote = await this.remote(key);
    }
    if (remote === null || checksum(remote) !== hash) throw new Error("Object storage copy differs; local file retained");
    const url = `${this.options.publicBaseUrl.replace(/\/+$/u, "")}/${key}`;
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("image/")) {
      throw Object.assign(new Error("CDN copy unavailable; local file retained"), { code: "CDN_UNAVAILABLE", status: response.status });
    }
    if (checksum(Buffer.from(await response.arrayBuffer())) !== hash) throw new Error("CDN copy differs; local file retained");
    // Check both identity and content again after remote requests.
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || checksum(await readFile(path)) !== hash) {
      throw new Error("Local image changed during transfer; retained");
    }
    await unlink(path);
    return { deletedBytes: body.length, uploaded, skipped: false };
  }

  private async remote(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key })) as GetObjectCommandOutput;
      if (result.Body === undefined) throw new Error("Object storage body missing");
      const body = Buffer.from(await result.Body.transformToByteArray());
      if (result.ContentLength !== undefined && result.ContentLength !== body.length) throw new Error("Object storage body incomplete");
      return body;
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") return null;
      throw error;
    }
  }
}
