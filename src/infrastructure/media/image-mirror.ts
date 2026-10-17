import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { PermanentError, RetryableError } from "../../core/errors/index.js";
import type { SqlExecutor } from "../db/sql-executor.js";
import type { S3ImageStoreOptions } from "./s3-image-store.js";

export interface ImageMirrorRequest {
  readonly key: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ImageMirrorQueue {
  readonly destinationId: string;
  enqueue(request: ImageMirrorRequest): Promise<void>;
}

// Receipts outlive job retention: publishing an immutable key again must not create another job.
export class PostgresImageMirrorQueue implements ImageMirrorQueue {
  constructor(private readonly db: SqlExecutor, readonly destinationId: string) {}

  async enqueue(request: ImageMirrorRequest): Promise<void> {
    const result = await this.db.query(`WITH receipt AS (
      INSERT INTO image_mirror_objects(destination_id,object_key,sha256,size_bytes)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(destination_id,object_key) DO UPDATE SET object_key=EXCLUDED.object_key
      RETURNING *, (xmax=0) AS inserted
    ), job AS (
      INSERT INTO jobs(job_type,payload,status,available_at,unique_key)
      SELECT 'mirror_image',jsonb_build_object('destinationId',destination_id,'key',object_key,
        'sha256',sha256,'size',size_bytes),'pending',NOW(),destination_id || ':' || object_key
      FROM receipt WHERE inserted
      RETURNING id
    ) SELECT sha256,size_bytes,(SELECT id FROM job) AS job_id FROM receipt`,
    [this.destinationId, request.key, request.sha256, request.size]);
    const row = result.rows[0];
    if (row?.sha256 !== request.sha256 || Number(row.size_bytes) !== request.size) {
      throw new PermanentError("Image mirror key has different content", { code: "IMAGE_MIRROR_CONFLICT" });
    }
  }

  async complete(request: ImageMirrorRequest): Promise<void> {
    const result = await this.db.query(`UPDATE image_mirror_objects SET copied_at=COALESCE(copied_at,NOW())
      WHERE destination_id=$1 AND object_key=$2 AND sha256=$3 AND size_bytes=$4 RETURNING object_key`,
    [this.destinationId, request.key, request.sha256, request.size]);
    if (result.rows.length !== 1) throw new Error("Image mirror receipt is missing");
  }
}

export type MirrorStorageOptions = Pick<S3ImageStoreOptions, "endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey">;
export interface MirrorClient {
  send(command: GetObjectCommand | HeadObjectCommand | PutObjectCommand): Promise<unknown>;
}
export function createMirrorClient(options: MirrorStorageOptions): MirrorClient {
  return new S3Client({ endpoint: options.endpoint, region: options.region, forcePathStyle: true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    requestHandler: { connectionTimeout: 15_000, requestTimeout: 90_000, throwOnRequestTimeout: true }, maxAttempts: 3 });
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}
function isMissing(error: unknown): boolean {
  return httpStatus(error) === 404 || (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name));
}

export class ImageMirrorRunner {
  constructor(private readonly queue: PostgresImageMirrorQueue,
    private readonly sourceBucket: string, private readonly destinationBucket: string,
    private readonly source: MirrorClient, private readonly destination: MirrorClient) {}

  async copy(payload: unknown): Promise<{ status: "completed" }> {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new PermanentError("Invalid image mirror payload", { code: "IMAGE_MIRROR_PAYLOAD" });
    }
    const { key, sha256, size, destinationId } = payload as Record<string, unknown>;
    if (destinationId !== this.queue.destinationId || typeof key !== "string" || key === ""
      || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)
      || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) {
      throw new PermanentError("Invalid image mirror payload", { code: "IMAGE_MIRROR_PAYLOAD" });
    }
    const request = { key, sha256, size };
    try {
      const object = await this.source.send(new GetObjectCommand({ Bucket: this.sourceBucket, Key: key })) as GetObjectCommandOutput;
      if (!object.Body) throw new RetryableError("Primary image body is missing", { code: "IMAGE_MIRROR_SOURCE" });
      const body = Buffer.from(await object.Body.transformToByteArray());
      if (body.length !== size || (object.ContentLength !== undefined && object.ContentLength !== size)
        || createHash("sha256").update(body).digest("hex") !== sha256) {
        throw new PermanentError("Primary image checksum mismatch", { code: "IMAGE_MIRROR_CHECKSUM" });
      }
      if (!(await this.matchesExisting(request, body, object))) {
        try {
          await this.destination.send(new PutObjectCommand({ Bucket: this.destinationBucket, Key: key,
            Body: body, ContentLength: size, ContentMD5: createHash("md5").update(body).digest("base64"),
            IfNoneMatch: "*", ContentType: object.ContentType, CacheControl: object.CacheControl,
            Metadata: object.Metadata, ContentDisposition: object.ContentDisposition,
            ContentEncoding: object.ContentEncoding, ContentLanguage: object.ContentLanguage, Expires: object.Expires }));
        } catch (error) {
          if (httpStatus(error) !== 412) throw error;
          if (!(await this.matchesExisting(request, body, object))) throw error;
        }
      }
      await this.queue.complete(request);
      return { status: "completed" };
    } catch (error) {
      if (error instanceof PermanentError || error instanceof RetryableError) throw error;
      const status = httpStatus(error);
      const code = (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
      if (isMissing(error) || status === 409 || status === 429 || (status !== undefined && status >= 500)
        || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EPIPE"].includes(code ?? "")
        || (error instanceof Error && ["TimeoutError", "RequestTimeout", "SlowDown"].includes(error.name))) {
        throw new RetryableError(`Image mirror temporarily unavailable (${status ?? code ?? "timeout"})`, { code: "IMAGE_MIRROR_UNAVAILABLE" });
      }
      // SDK errors can contain signed URLs; keep persisted diagnostics free of credentials.
      throw new PermanentError(`Image mirror failed (${status ?? "internal"})`, { code: "IMAGE_MIRROR_FAILED" });
    }
  }

  private async matchesExisting(request: ImageMirrorRequest, body: Buffer, source: GetObjectCommandOutput): Promise<boolean> {
    let head: Pick<GetObjectCommandOutput, "ContentLength" | "ETag" | "ContentType" | "CacheControl" | "Metadata" | "ContentDisposition" | "ContentEncoding" | "ContentLanguage">;
    try { head = await this.destination.send(new HeadObjectCommand({ Bucket: this.destinationBucket, Key: request.key })) as typeof head; }
    catch (error) { if (isMissing(error)) return false; throw error; }
    if (head.ContentLength !== request.size) throw new PermanentError("Mirror contains different content", { code: "IMAGE_MIRROR_CONFLICT" });
    for (const field of ["ContentType", "CacheControl", "ContentDisposition", "ContentEncoding", "ContentLanguage"] as const) {
      if (source[field] !== undefined && head[field] !== source[field]) {
        throw new PermanentError("Mirror contains different metadata", { code: "IMAGE_MIRROR_CONFLICT" });
      }
    }
    if (Object.entries(source.Metadata ?? {}).some(([key, value]) => head.Metadata?.[key] !== value)) {
      throw new PermanentError("Mirror contains different metadata", { code: "IMAGE_MIRROR_CONFLICT" });
    }
    if (head.ETag?.replaceAll('"', "") === createHash("md5").update(body).digest("hex")) return true;
    // Older multipart copies may have a multipart ETag. Only these need a content read.
    const existing = await this.destination.send(new GetObjectCommand({ Bucket: this.destinationBucket, Key: request.key })) as GetObjectCommandOutput;
    if (!existing.Body || createHash("sha256").update(await existing.Body.transformToByteArray()).digest("hex") !== request.sha256) {
      throw new PermanentError("Mirror contains different content", { code: "IMAGE_MIRROR_CONFLICT" });
    }
    return true;
  }
}
