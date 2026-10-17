import { readFile, mkdir, rename, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Agent } from "node:https";
import { S3Client } from "@aws-sdk/client-s3";
import { loadProcessingConfig } from "../config/processing-config.js";
import { LegacyImageTransfer, transferLegacyImageBatch, nextLegacyFailedBatchCount } from "../infrastructure/media/legacy-image-transfer.js";
import { legacyImageFiles } from "../infrastructure/media/legacy-image-files.js";
import { legacyImageBatches } from "../infrastructure/media/legacy-image-batches.js";
import { createPostgresPool } from "../infrastructure/db/index.js";
import { createImageMirrorQueue } from "../bootstrap.js";

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
const config = loadProcessingConfig().image;
if (config.storage.type !== "s3") throw new Error("Legacy transfer requires S3 storage");
const options = { ...config, ...config.storage };
const client = new S3Client({ endpoint: options.endpoint, region: options.region, forcePathStyle: true,
  maxAttempts: 2, requestHandler: { requestTimeout: 30_000, throwOnRequestTimeout: true, connectionTimeout: 10_000,
    httpsAgent: new Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 256 }) },
  credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } });
const mirrorPool = options.mirror === undefined ? undefined : createPostgresPool();
const transfer = new LegacyImageTransfer(options, client, undefined,
  mirrorPool === undefined ? undefined : createImageMirrorQueue(mirrorPool));
const delayMs = integer("IMAGE_TRANSFER_DELAY_MS", 1000);
const concurrency = integer("IMAGE_TRANSFER_CONCURRENCY", 1);
if (concurrency > 256) throw new Error("IMAGE_TRANSFER_CONCURRENCY must not exceed 256");
const maximumBatchBytes = 64 * 1024 * 1024;
const minimumAgeMs = integer("IMAGE_TRANSFER_MINIMUM_AGE_HOURS", 24) * 3_600_000;
const limit = integer("IMAGE_TRANSFER_LIMIT", Number.MAX_SAFE_INTEGER);
const checkpoint = process.env.IMAGE_TRANSFER_CHECKPOINT ?? join(dirname(config.baseDirectory), "legacy-image-transfer.json");
const selectedPath = process.env.IMAGE_TRANSFER_RELATIVE_PATH;
let startDirectory: string | undefined;
if (!selectedPath) {
  try {
    const previous = JSON.parse(await readFile(checkpoint, "utf8")) as { complete?: boolean; lastPath?: unknown };
    if (previous.complete === false && typeof previous.lastPath === "string" && previous.lastPath !== "") {
      startDirectory = previous.lastPath.slice(0, previous.lastPath.lastIndexOf("/"));
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
const progress = { startedAt: new Date().toISOString(), updatedAt: "", visited: 0, deleted: 0,
  deletedBytes: 0, uploaded: 0, skipped: 0, failed: 0, lastPath: "", startDirectory: startDirectory ?? null, complete: false };
let consecutiveFailedBatches = 0;
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
  let count = 0;
  for await (const path of legacyImageFiles(config.baseDirectory, startDirectory, () => stopping)) {
    if (stopping || count >= limit) break;
    count++;
    yield path;
  }
}
await save();
async function processBatch(paths: readonly string[]): Promise<void> {
  progress.visited += paths.length;
  progress.lastPath = paths.at(-1) ?? "";
  const outcomes = await transferLegacyImageBatch(transfer, paths, minimumAgeMs);
  consecutiveFailedBatches = nextLegacyFailedBatchCount(consecutiveFailedBatches, outcomes);
  for (const { path, result, failure } of outcomes) {
    if (result !== null) {
      progress.deletedBytes += result.deletedBytes;
      if (result.skipped) progress.skipped++; else progress.deleted++;
      if (result.uploaded) progress.uploaded++;
    } else {
      progress.failed++;
      console.error(JSON.stringify({ path, error: "transfer_failed_local_file_retained", failure }));
    }
  }
  if (consecutiveFailedBatches >= 5) throw new Error("Five entirely failed transfer batches; stopped without removing unverified files");
  if (Date.now() - lastSaved >= 15_000) await save();
  await new Promise((done) => setTimeout(done, delayMs));
}
try {
  for await (const batch of legacyImageBatches(paths(), concurrency, maximumBatchBytes,
    async (path) => (await lstat(join(config.baseDirectory, path))).size)) {
    if (stopping) break;
    await processBatch(batch);
  }
  progress.complete = !stopping && progress.visited < limit;
} finally {
  try { await save(); }
  finally { client.destroy(); await mirrorPool?.end(); }
}
