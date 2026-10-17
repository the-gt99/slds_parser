import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ImageMirrorRunner, PostgresImageMirrorQueue } from "../../src/infrastructure/media/image-mirror.js";

const body = Buffer.from("immutable webp content");
const sha256 = createHash("sha256").update(body).digest("hex");
const payload = { destinationId: "destination", key: `parser/goat/item_1/01-main.${sha256}.webp`, sha256, size: body.length };
const missing = () => Object.assign(new Error("Missing"), { $metadata: { httpStatusCode: 404 } });
const metadata = { ContentType: "image/webp", CacheControl: "public, max-age=31536000, immutable", Metadata: { source: "goat" } };

function setup() {
  const complete = vi.fn(async () => {});
  const queue = { destinationId: "destination", complete } as unknown as PostgresImageMirrorQueue;
  const source = { send: vi.fn(async () => ({ ...metadata, ContentLength: body.length, Body: { transformToByteArray: async () => body } })) };
  const destination = { send: vi.fn(async (command: GetObjectCommand | HeadObjectCommand | PutObjectCommand): Promise<unknown> => {
    if (command instanceof HeadObjectCommand) throw missing();
    return {};
  }) };
  const runner = new ImageMirrorRunner(queue, "primary", "mirror", source, destination);
  return { runner, source, destination, complete };
}

describe("durable image mirroring", () => {
  it("copies the same key with metadata, transfer checksum and an atomic no-overwrite condition", async () => {
    const s = setup(); await expect(s.runner.copy(payload)).resolves.toEqual({ status: "completed" });
    const put = s.destination.send.mock.calls[1]![0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({ ...metadata, Bucket: "mirror", Key: payload.key, Body: body,
      IfNoneMatch: "*", ContentLength: body.length, ContentMD5: createHash("md5").update(body).digest("base64") });
    expect(s.complete).toHaveBeenCalledOnce();
  });
  it("does not PUT or download a matching object on retry", async () => {
    const s = setup(); s.destination.send.mockResolvedValue({ ...metadata, ContentLength: body.length,
      ETag: `"${createHash("md5").update(body).digest("hex")}"` });
    await s.runner.copy(payload);
    expect(s.destination.send).toHaveBeenCalledOnce(); expect(s.complete).toHaveBeenCalledOnce();
  });
  it("retains a retryable request when the primary PUT has not completed or the mirror is unavailable", async () => {
    const s = setup(); s.source.send.mockRejectedValue(missing());
    await expect(s.runner.copy(payload)).rejects.toMatchObject({ code: "IMAGE_MIRROR_UNAVAILABLE" });
    expect(s.complete).not.toHaveBeenCalled();
    const other = setup(); other.destination.send.mockRejectedValue({ $metadata: { httpStatusCode: 503 } });
    await expect(other.runner.copy(payload)).rejects.toMatchObject({ code: "IMAGE_MIRROR_UNAVAILABLE" });
    expect(other.complete).not.toHaveBeenCalled();
  });
  it("never overwrites different existing content or accepts a corrupt primary body", async () => {
    const s = setup(); s.destination.send.mockResolvedValue({ ContentLength: 100 });
    await expect(s.runner.copy(payload)).rejects.toMatchObject({ code: "IMAGE_MIRROR_CONFLICT" });
    expect(s.destination.send).toHaveBeenCalledOnce(); expect(s.complete).not.toHaveBeenCalled();
    const corrupt = setup(); corrupt.source.send.mockResolvedValue({ ...metadata, ContentLength: body.length,
      Body: { transformToByteArray: async () => Buffer.alloc(body.length) } });
    await expect(corrupt.runner.copy(payload)).rejects.toMatchObject({ code: "IMAGE_MIRROR_CHECKSUM" });
    expect(corrupt.destination.send).not.toHaveBeenCalled();
  });
  it("checks historical multipart content only when ETag cannot establish equality", async () => {
    const s = setup(); s.destination.send.mockImplementation(async (command) => command instanceof HeadObjectCommand
      ? { ...metadata, ContentLength: body.length, ETag: '"multipart-2"' }
      : { Body: { transformToByteArray: async () => body } });
    await s.runner.copy(payload); expect(s.destination.send).toHaveBeenCalledTimes(2);
    expect(s.destination.send.mock.calls[1]![0]).toBeInstanceOf(GetObjectCommand);
  });
  it("rechecks a competing conditional PUT instead of overwriting its object", async () => {
    const s = setup(); let calls = 0;
    s.destination.send.mockImplementation(async (command) => {
      if (command instanceof PutObjectCommand) throw { $metadata: { httpStatusCode: 412 } };
      if (++calls === 1) throw missing();
      return { ...metadata, ContentLength: body.length, ETag: `"${createHash("md5").update(body).digest("hex")}"` };
    });
    await s.runner.copy(payload); expect(s.complete).toHaveBeenCalledOnce();
  });
  it("rejects invalid payloads and redacts unexpected SDK diagnostics", async () => {
    const s = setup(); await expect(s.runner.copy(null)).rejects.toMatchObject({ code: "IMAGE_MIRROR_PAYLOAD" });
    await expect(s.runner.copy({ ...payload, destinationId: "other" })).rejects.toMatchObject({ code: "IMAGE_MIRROR_PAYLOAD" });
    s.source.send.mockRejectedValue(new Error("secret signed URL"));
    await expect(s.runner.copy(payload)).rejects.toThrow("Image mirror failed (internal)");
  });
});
