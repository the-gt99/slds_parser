import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { legacyImageFiles } from "../../src/infrastructure/media/legacy-image-files.js";

describe("legacy image directory resume", () => {
  it("starts at the checkpoint and wraps around without losing earlier directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "slds-image-resume-"));
    try {
      for (const product of ["item_1", "item_2", "item_3"]) {
        await mkdir(join(root, "goat", product), { recursive: true });
        await writeFile(join(root, "goat", product, "01-main.webp"), "fixture");
      }
      await writeFile(join(root, "goat/item_2", "original.jpg"), "ignored");
      const paths: string[] = [];
      for await (const path of legacyImageFiles(root, "goat/item_3")) paths.push(path);
      expect(paths[0]).toBe("goat/item_3/01-main.webp");
      expect(paths.sort()).toEqual(["goat/item_1/01-main.webp", "goat/item_2/01-main.webp", "goat/item_3/01-main.webp"]);
      const stopped: string[] = [];
      for await (const path of legacyImageFiles(root, undefined, () => true)) stopped.push(path);
      expect(stopped).toEqual([]);
      await expect(legacyImageFiles(root, "../outside").next()).rejects.toThrow("Invalid");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
