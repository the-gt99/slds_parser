import { PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { S3ImageStore, type ObjectStorageClient } from "../../src/infrastructure/media/index.js";

describe("S3 image store", () => {
  it("uploads the converted WebP under the public object key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slds-s3-images-"));
    const commands: PutObjectCommand[] = [];
    const client: ObjectStorageClient = {
      send: vi.fn(async (command) => {
        commands.push(command);
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
      const binary = await sharp({
        create: { width: 2, height: 3, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
      }).png().toBuffer();
      const original = await store.storeOriginal("goat", "2", 0, binary);
      const webpPath = await store.convertToWebp(original.localPath);

      await expect(store.publish(webpPath)).resolves.toBe(
        "https://storage.yandexcloud.net/slamdunk/products/goat/item_2/01-main.webp",
      );
      expect(commands).toHaveLength(1);
      expect(commands[0]?.input).toMatchObject({
        Bucket: "slamdunk",
        Key: "products/goat/item_2/01-main.webp",
        ContentType: "image/webp",
      });
      expect(commands[0]?.input.Body).toBeInstanceOf(Buffer);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
