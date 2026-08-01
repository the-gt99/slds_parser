import type { WorkerOptions } from "../application/index.js";

export interface WorkerEnvironment {
  readonly WORKER_ID?: string;
  readonly WORKER_POLL_INTERVAL_MS?: string;
  readonly WORKER_LOCK_TIMEOUT_MS?: string;
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

export function loadWorkerConfig(environment: WorkerEnvironment = process.env): WorkerOptions {
  const workerId = environment.WORKER_ID?.trim();
  if (!workerId) throw new Error("WORKER_ID is required");
  const options = {
    workerId,
    pollIntervalMs: positiveInteger(environment, "WORKER_POLL_INTERVAL_MS"),
    lockTimeoutMs: positiveInteger(environment, "WORKER_LOCK_TIMEOUT_MS"),
    maxJobAttempts: positiveInteger(environment, "MAX_JOB_ATTEMPTS"),
    retryBaseMs: positiveInteger(environment, "JOB_RETRY_BASE_MS"),
    retryMaxMs: positiveInteger(environment, "JOB_RETRY_MAX_MS"),
  };
  if (options.retryBaseMs > options.retryMaxMs) throw new Error("JOB_RETRY_BASE_MS must not exceed JOB_RETRY_MAX_MS");
  return options;
}
