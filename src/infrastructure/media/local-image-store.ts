import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { posix } from "node:path";

import sharp from "sharp";

import type { ImageStore, StoredImageAsset } from "../../processing/media/index.js";

export interface LocalImageStoreOptions {
  readonly baseDirectory: string;
  readonly publicBaseUrl: string;
  readonly publicPathPrefix?: string;
  readonly webpQuality: number;
}

function safeSegment(value: string, label: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (safe === "") throw new Error(`${label} cannot be used in an image path`);
  return safe;
}

function extensionForFormat(format: string): string {
  switch (format) {
    case "jpeg": return "jpg";
    case "png": return "png";
    case "webp": return "webp";
    case "gif": return "gif";
    default: throw new Error(`Unsupported image format: ${format}`);
  }
}

function mimeForFormat(format: string): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function assertCompleteImage(format: string, binary: Buffer): void {
  let complete = true;
  if (format === "png") complete = binary.length >= 12 && binary.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"));
  if (format === "jpeg") complete = binary.length >= 2 && binary.subarray(-2).equals(Buffer.from("ffd9", "hex"));
  if (format === "gif") complete = binary.length >= 1 && binary[binary.length - 1] === 0x3b;
  if (format === "webp") {
    const declaredSize = binary.length >= 8 ? binary.readUInt32LE(4) : 0;
    complete = binary.length >= 12 && binary.subarray(0, 4).toString("ascii") === "RIFF"
      && binary.subarray(8, 12).toString("ascii") === "WEBP" && declaredSize > 0 && binary.length >= declaredSize + 8;
  }
  if (!complete) throw new Error("Downloaded image is incomplete or corrupted");
}

export class LocalImageStore implements ImageStore {
  readonly #baseDirectory: string;

  constructor(private readonly options: LocalImageStoreOptions) {
    this.#baseDirectory = resolve(options.baseDirectory);
    if (!Number.isInteger(options.webpQuality) || options.webpQuality < 1 || options.webpQuality > 100) {
      throw new Error("Image WebP quality must be an integer from 1 to 100");
    }
  }

  fingerprint(): Record<string, string | number> {
    return {
      baseDirectory: this.#baseDirectory,
      publicBaseUrl: this.options.publicBaseUrl,
      publicPathPrefix: this.options.publicPathPrefix ?? "",
      webpQuality: this.options.webpQuality,
    };
  }

  async storeOriginal(
    sourceCode: string,
    sourceProductId: string,
    position: number,
    binary: Buffer,
  ): Promise<StoredImageAsset> {
    const image = sharp(binary, { failOn: "warning" });
    const metadata = await image.metadata();
    const format = metadata.format;
    if (format === undefined) throw new Error("Downloaded image format cannot be detected");
    const extension = extensionForFormat(format);
    assertCompleteImage(format, binary);
    await image.clone().raw().toBuffer();
    const relativeDirectory = posix.join(
      safeSegment(sourceCode, "Source code"),
      `item_${safeSegment(sourceProductId, "Source product id")}`,
    );
    const prefix = String(position + 1).padStart(2, "0");
    const relativePath = posix.join(relativeDirectory, `${prefix}${position === 0 ? "-main" : ""}.${extension}`);
    await this.writeAtomic(this.resolvePath(relativePath), binary);
    return {
      localPath: relativePath,
      mimeType: mimeForFormat(format),
      storedFormat: extension,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
    };
  }

  async convertToWebp(localPath: string): Promise<string> {
    const normalized = localPath.replaceAll("\\", "/").replace(/^\/+/, "");
    if (extname(normalized).toLowerCase() === ".webp") return normalized;
    const webpPath = normalized.slice(0, -extname(normalized).length) + ".webp";
    const target = this.resolvePath(webpPath);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await this.#prepareDirectory(dirname(target));
    try {
      await sharp(this.resolvePath(normalized), { failOn: "warning" }).webp({ quality: this.options.webpQuality }).toFile(temporary);
      await rename(temporary, target);
      await chmod(target, 0o640);
    } finally {
      await rm(temporary, { force: true });
    }
    return webpPath;
  }

  publicUrl(localPath: string): string {
    const base = this.options.publicBaseUrl.trim().replace(/\/+$/u, "");
    if (base === "") throw new Error("Image public base URL is not configured");
    const prefix = (this.options.publicPathPrefix ?? "").trim().replace(/^\/+|\/+$/gu, "");
    const relative = localPath.replaceAll("\\", "/").replace(/^\/+/, "");
    return `${base}/${prefix === "" ? "" : `${prefix}/`}${relative}`;
  }

  resolvePath(localPath: string): string {
    const relative = localPath.replaceAll("\\", "/").replace(/^\/+/, "");
    if (relative === "") throw new Error("Local image path is empty");
    const path = resolve(this.#baseDirectory, relative);
    if (path !== this.#baseDirectory && !path.startsWith(`${this.#baseDirectory}${sep}`)) {
      throw new Error("Local image path leaves the configured storage directory");
    }
    return path;
  }

  async writeAtomic(target: string, binary: Buffer): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    await this.#prepareDirectory(dirname(target));
    try {
      await writeFile(temporary, binary);
      await rename(temporary, target);
      await chmod(target, 0o640);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #prepareDirectory(directory: string): Promise<void> {
    const relativeDirectory = relative(this.#baseDirectory, directory);
    if (relativeDirectory.startsWith("..") || resolve(directory) === resolve(this.#baseDirectory, "..")) {
      throw new Error("Image directory leaves the configured storage directory");
    }
    let current = this.#baseDirectory;
    await mkdir(current, { recursive: true });
    await chmod(current, 0o750);
    for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
      current = resolve(current, segment);
      await mkdir(current, { recursive: true });
      await chmod(current, 0o750);
    }
  }
}
