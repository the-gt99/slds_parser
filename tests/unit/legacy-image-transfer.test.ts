import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LegacyImageTransfer, transferLegacyImageBatch, legacyImageFailure } from "../../src/infrastructure/media/legacy-image-transfer.js";

const roots: string[] = [];
const body = Buffer.from("RIFF1234WEBPimage-bytes");
async function fixture(remote?: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "slds-legacy-images-")); roots.push(root);
  const relative = "goat/item_2/01-main.webp";
  const path = join(root, relative);
  await mkdir(join(root, "goat/item_2"), { recursive: true });
  await writeFile(path, body);
  const send = vi.fn(async (command: GetObjectCommand | PutObjectCommand) => {
    if (command instanceof PutObjectCommand) { remote = command.input.Body as Buffer; return {}; }
    if (!remote) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    return { Body: { transformToByteArray: async () => remote }, ContentLength: remote.length };
  });
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
    new Response(new Uint8Array(body), { headers: { "content-type": "image/webp" } }));
  const transfer = new LegacyImageTransfer({ baseDirectory: root, publicBaseUrl: "https://cdn.example.test",
    publicPathPrefix: "parser", webpQuality: 85, endpoint: "https://s3.example.test", region: "test",
    bucket: "test", accessKeyId: "test", secretAccessKey: "test" }, { send }, fetchImpl);
  return { root, path, relative, transfer, send, fetchImpl };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("legacy image transfer", () => {
  it("reports only safe transport codes and HTTP status, without messages or credentials", () => {
    expect(legacyImageFailure({ name: "SlowDown", $metadata: { httpStatusCode: 503 }, message: "secret" }))
      .toEqual({ name: "SlowDown", status: 503, code: undefined });
    expect(legacyImageFailure({ name: "TypeError", cause: { code: "ECONNRESET" } }).code).toBe("ECONNRESET");
    expect(legacyImageFailure({ name: "https://secret", code: "Bearer secret", status: 999 }))
      .toEqual({ name: "Error", status: undefined, code: undefined });
    expect(legacyImageFailure(null).name).toBe("Error");
  });
  it.each([2, 6, 24, 96, 192, 256])("overlaps %i transfers and waits for all verified outcomes", async (concurrency) => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let started = 0;
    const transfer = { transfer: vi.fn(async () => {
      if (++started === concurrency) release();
      await gate;
      return { deletedBytes: 10, uploaded: true, skipped: false };
    }) };
    const paths = Array.from({ length: concurrency }, (_, index) => `file-${index}`);
    const result = await transferLegacyImageBatch(transfer, paths, 0);
    expect(started).toBe(concurrency);
    expect(result.map((entry) => entry.path)).toEqual(paths);
    expect(result.every((entry) => entry.result?.deletedBytes === 10)).toBe(true);
  });
  it("keeps a failed transfer separate from a successful parallel file", async () => {
    const transfer = { transfer: vi.fn(async (path: string) => {
      if (path === "failed") throw new Error("failure");
      return { deletedBytes: 10, uploaded: false, skipped: false };
    }) };
    const result = await transferLegacyImageBatch(transfer, ["failed", "ok"], 0);
    expect(result[0]?.result).toBeNull();
    expect(result[1]?.result?.deletedBytes).toBe(10);
    await expect(transferLegacyImageBatch(transfer, ["duplicate", "duplicate"], 0)).rejects.toThrow("Duplicate");
    expect(transfer.transfer).toHaveBeenCalledTimes(2);
  });
  it("preserves the legacy key and removes only a storage- and CDN-verified copy", async () => {
    const f = await fixture();
    await expect(f.transfer.transfer(f.relative, 0)).resolves.toEqual({ deletedBytes: body.length, uploaded: true, skipped: false });
    const put = f.send.mock.calls.map(([command]) => command).find((command) => command instanceof PutObjectCommand);
    expect(put?.input).toMatchObject({ Key: "parser/goat/item_2/01-main.webp", IfNoneMatch: "*" });
    expect(f.fetchImpl).toHaveBeenCalledWith("https://cdn.example.test/parser/goat/item_2/01-main.webp", expect.anything());
    await expect(access(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("reuses an identical existing object without overwriting it", async () => {
    const f = await fixture(body);
    await expect(f.transfer.transfer(f.relative, 0)).resolves.toMatchObject({ uploaded: false });
    expect(f.send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });
  it("retains the local file and never overwrites a different existing object", async () => {
    const f = await fixture(Buffer.from("different"));
    await expect(f.transfer.transfer(f.relative, 0)).rejects.toThrow("differs");
    expect(f.send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
    await expect(readFile(f.path)).resolves.toEqual(body);
  });
  it("retains the local file when CDN verification fails", async () => {
    const f = await fixture();
    f.fetchImpl.mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(f.transfer.transfer(f.relative, 0)).rejects.toThrow("CDN copy unavailable");
    await expect(access(f.path)).resolves.toBeUndefined();
  });
  it("retains the local file when upload fails", async () => {
    const f = await fixture();
    f.send.mockImplementation(async (command) => {
      if (command instanceof PutObjectCommand) throw new Error("upload rejected");
      throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    });
    await expect(f.transfer.transfer(f.relative, 0)).rejects.toThrow("upload rejected");
    await expect(access(f.path)).resolves.toBeUndefined();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("retains the local file when CDN returns other bytes", async () => {
    const f = await fixture();
    f.fetchImpl.mockResolvedValue(new Response("wrong", { headers: { "content-type": "image/webp" } }));
    await expect(f.transfer.transfer(f.relative, 0)).rejects.toThrow("CDN copy differs");
    await expect(access(f.path)).resolves.toBeUndefined();
  });
  it("retains a file modified while remote verification runs", async () => {
    const f = await fixture();
    f.fetchImpl.mockImplementation(async () => {
      await writeFile(f.path, Buffer.concat([body, Buffer.from("changed")]));
      return new Response(new Uint8Array(body), { headers: { "content-type": "image/webp" } });
    });
    await expect(f.transfer.transfer(f.relative, 0)).rejects.toThrow("changed during transfer");
    await expect(access(f.path)).resolves.toBeUndefined();
  });
  it("skips recent staging files without remote requests", async () => {
    const f = await fixture();
    await expect(f.transfer.transfer(f.relative, 86_400_000)).resolves.toMatchObject({ skipped: true, deletedBytes: 0 });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects traversal and symlinked storage directories", async () => {
    const f = await fixture();
    await expect(f.transfer.transfer("../outside.webp", 0)).rejects.toThrow("Unsupported");
    await symlink(join(f.root, "goat/item_2"), join(f.root, "goat/item_3"), "junction");
    await expect(f.transfer.transfer("goat/item_3/01-main.webp", 0)).rejects.toThrow("regular storage file");
    expect(f.send).not.toHaveBeenCalled();
  });
});
