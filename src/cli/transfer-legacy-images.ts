import { opendir, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { loadProcessingConfig } from "../config/processing-config.js";
import { LegacyImageTransfer, transferLegacyImageBatch } from "../infrastructure/media/legacy-image-transfer.js";

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
const config = loadProcessingConfig().image;
if (config.storage.type !== "s3") throw new Error("Legacy transfer requires S3 storage");
const options = { ...config, ...config.storage };
const client = new S3Client({ endpoint: options.endpoint, region: options.region, forcePathStyle: true,
  maxAttempts: 2, requestHandler: { requestTimeout: 30_000, connectionTimeout: 10_000 },
  credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } });
const transfer = new LegacyImageTransfer(options, client);
const delayMs = integer("IMAGE_TRANSFER_DELAY_MS", 1000);
const concurrency = integer("IMAGE_TRANSFER_CONCURRENCY", 1);
if (concurrency > 4) throw new Error("IMAGE_TRANSFER_CONCURRENCY must not exceed 4");
const minimumAgeMs = integer("IMAGE_TRANSFER_MINIMUM_AGE_HOURS", 24) * 3_600_000;
const limit = integer("IMAGE_TRANSFER_LIMIT", Number.MAX_SAFE_INTEGER);
const checkpoint = process.env.IMAGE_TRANSFER_CHECKPOINT ?? join(dirname(config.baseDirectory), "legacy-image-transfer.json");
const selectedPath = process.env.IMAGE_TRANSFER_RELATIVE_PATH;
const progress = { startedAt: new Date().toISOString(), updatedAt: "", visited: 0, deleted: 0,
  deletedBytes: 0, uploaded: 0, skipped: 0, failed: 0, lastPath: "", complete: false };
let consecutiveFailures = 0;
let lastSaved = 0;
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function save(): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  await mkdir(dirname(checkpoint), { recursive: true });
  await writeFile(`${checkpoint}.tmp`, JSON.stringify(progress), { mode: 0o640 });
  await rename(`${checkpoint}.tmp`, checkpoint);
  console.info(JSON.stringify(progress));
  lastSaved = Date.now();
}
async function* paths(): AsyncGenerator<string> {
  if (selectedPath) { yield selectedPath; return; }
  const sources = await opendir(config.baseDirectory);
  for await (const source of sources) {
    if (!source.isDirectory() || !/^[a-zA-Z0-9_-]+$/u.test(source.name)) continue;
    const products = await opendir(join(config.baseDirectory, source.name));
    for await (const product of products) {
      if (stopping) return;
      if (!product.isDirectory() || !/^item_[a-zA-Z0-9_-]+$/u.test(product.name)) continue;
      const files = await opendir(join(config.baseDirectory, source.name, product.name));
      for await (const file of files) {
        if (file.isFile() && /^\d+(?:-main)?(?:\.[a-f0-9]{64})?\.webp$/u.test(file.name)) yield `${source.name}/${product.name}/${file.name}`;
      }
    }
  }
}
await save();
async function processBatch(paths: readonly string[]): Promise<void> {
  progress.visited += paths.length;
  progress.lastPath = paths.at(-1) ?? "";
  const outcomes = await transferLegacyImageBatch(transfer, paths, minimumAgeMs);
  let failureLimitReached = false;
  for (const { path, result } of outcomes) {
    if (result !== null) {
      progress.deletedBytes += result.deletedBytes;
      if (result.skipped) progress.skipped++; else progress.deleted++;
      if (result.uploaded) progress.uploaded++;
      consecutiveFailures = 0;
    } else {
      progress.failed++;
      consecutiveFailures++;
      if (consecutiveFailures >= 5) failureLimitReached = true;
      console.error(JSON.stringify({ path, error: "transfer_failed_local_file_retained" }));
    }
  }
  if (failureLimitReached) throw new Error("Repeated transfer failures; stopped without removing unverified files");
  if (Date.now() - lastSaved >= 15_000) await save();
  await new Promise((done) => setTimeout(done, delayMs));
}
try {
  let batch: string[] = [];
  for await (const path of paths()) {
    if (stopping || progress.visited >= limit) break;
    batch.push(path);
    if (batch.length >= concurrency || progress.visited + batch.length >= limit) {
      await processBatch(batch);
      batch = [];
    }
  }
  if (!stopping && batch.length > 0) await processBatch(batch);
  progress.complete = !stopping && progress.visited < limit;
} finally {
  await save();
  client.destroy();
}
