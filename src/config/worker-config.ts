import type { WorkerOptions } from "../application/index.js";

export interface WorkerEnvironment {
  readonly WORKER_ID?: string;
  readonly WORKER_POLL_INTERVAL_MS?: string;
  readonly WORKER_LOCK_TIMEOUT_MS?: string;
  readonly WORKER_PROCESS_CONCURRENCY?: string;
  readonly WORKER_COLLECTION_CONCURRENCY?: string;
  readonly MAX_JOB_ATTEMPTS?: string;
  readonly JOB_RETRY_BASE_MS?: string;
  readonly JOB_RETRY_MAX_MS?: string;
}

function positiveInteger(environment: WorkerEnvironment, key: keyof WorkerEnvironment): number {
  const raw = environment[key];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

function processConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new Error("WORKER_PROCESS_CONCURRENCY must be an integer from 1 to 16");
  }
  return parsed;
}

function collectionConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new Error("WORKER_COLLECTION_CONCURRENCY must be an integer from 1 to 16");
  }
  return parsed;
}

export function loadWorkerConfig(environment: WorkerEnvironment = process.env): WorkerOptions {
  const workerId = environment.WORKER_ID?.trim();
  if (!workerId) throw new Error("WORKER_ID is required");
  const options = {
    workerId,
    pollIntervalMs: positiveInteger(environment, "WORKER_POLL_INTERVAL_MS"),
    lockTimeoutMs: positiveInteger(environment, "WORKER_LOCK_TIMEOUT_MS"),
    processConcurrency: processConcurrency(environment.WORKER_PROCESS_CONCURRENCY),
    collectionConcurrency: collectionConcurrency(environment.WORKER_COLLECTION_CONCURRENCY),
    maxJobAttempts: positiveInteger(environment, "MAX_JOB_ATTEMPTS"),
    retryBaseMs: positiveInteger(environment, "JOB_RETRY_BASE_MS"),
    retryMaxMs: positiveInteger(environment, "JOB_RETRY_MAX_MS"),
  };
  if (options.retryBaseMs > options.retryMaxMs) throw new Error("JOB_RETRY_BASE_MS must not exceed JOB_RETRY_MAX_MS");
  return options;
}
