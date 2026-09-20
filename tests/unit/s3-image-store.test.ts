import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { S3ImageStore, type ObjectStorageClient } from "../../src/infrastructure/media/index.js";

describe("S3 image store", () => {
  it("uploads the converted WebP under the public object key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slds-s3-images-"));
    const commands: (PutObjectCommand | GetObjectCommand)[] = [];
    let stored: Buffer | undefined;
    let failUpload = false;
    const client: ObjectStorageClient = {
      send: vi.fn(async (command) => {
        commands.push(command);
        if (command instanceof GetObjectCommand && stored === undefined) throw Object.assign(new Error("Missing"), { name: "NoSuchKey" });
        if (command instanceof GetObjectCommand) return {
          Body: { transformToByteArray: async () => stored! }, ContentLength: stored!.length,
        };
        if (failUpload) throw new Error("Upload rejected");
        stored = command.input.Body as Buffer;
        return {};
      }),
    };
    const store = new S3ImageStore({
      baseDirectory: directory,
      publicBaseUrl: "https://storage.yandexcloud.net/slamdunk",
      publicPathPrefix: "products",
      webpQuality: 85,
      endpoint: "https://storage.yandexcloud.net",
      region: "ru-central1",
      bucket: "slamdunk",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    }, client);

    try {
      await expect(store.read("goat/item_2/missing.webp")).rejects.toMatchObject({ code: "ENOENT" });
      commands.length = 0;
      const binary = await sharp({
        create: { width: 2, height: 3, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
      }).png().toBuffer();
      const original = await store.storeOriginal("goat", "2", 0, binary);
      const webpPath = await store.convertToWebp(original.localPath);

      await expect(store.publish(webpPath)).resolves.toBe(
        `https://storage.yandexcloud.net/slamdunk/products/${webpPath}`,
      );
      expect(commands).toHaveLength(1);
      expect(commands[0]?.input).toMatchObject({
        Bucket: "slamdunk",
        Key: `products/${webpPath}`,
        ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable",
      });
      expect((commands[0] as PutObjectCommand).input.Body).toBeInstanceOf(Buffer);
      expect(webpPath).toMatch(/01-main\.[a-f0-9]{64}\.webp$/u);
      await expect(access(join(directory, webpPath))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(store.read(webpPath)).resolves.toEqual(stored);
      await expect(store.convertToWebp(webpPath)).resolves.toBe(webpPath);
      await expect(store.publish(webpPath)).resolves.toContain(webpPath);

      const next = await store.storeOriginal("goat", "2", 0, binary);
      const nextWebp = await store.convertToWebp(next.localPath);
      failUpload = true;
      await expect(store.publish(nextWebp)).rejects.toThrow("Upload rejected");
      await expect(access(join(directory, nextWebp))).resolves.toBeUndefined();
      await expect(store.read("../outside.webp")).rejects.toThrow("leaves");
      await rm(join(directory, nextWebp));
      stored = Buffer.from("corrupted");
      await expect(store.read(nextWebp)).rejects.toThrow("checksum");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
