import type { WorkerOptions } from "../application/index.js";

export interface WorkerEnvironment {
  readonly WORKER_ID?: string;
  readonly WORKER_ROLE?: string;
  readonly WORKER_POLL_INTERVAL_MS?: string;
  readonly WORKER_LOCK_TIMEOUT_MS?: string;
  readonly WORKER_PROCESS_CONCURRENCY?: string;
  readonly WORKER_TRANSLATION_CONCURRENCY?: string;
  readonly WORKER_COLLECTION_CONCURRENCY?: string;
  readonly WORKER_PREFLIGHT_CONCURRENCY?: string;
  readonly WORKER_CLASSIFICATION_APPLY_CONCURRENCY?: string;
  readonly WORKER_EXPORT_CONCURRENCY?: string;
  readonly WORKER_EXPORT_REFRESH_CONCURRENCY?: string;
  readonly WORKER_INVENTORY_REFRESH_CONCURRENCY?: string;
  readonly WORKER_INVENTORY_PREPARE_CONCURRENCY?: string;
  readonly WORKER_INVENTORY_SUBMIT_CONCURRENCY?: string;
  readonly MAX_JOB_ATTEMPTS?: string;
  readonly JOB_RETRY_BASE_MS?: string;
  readonly JOB_RETRY_MAX_MS?: string;
  readonly WORDPRESS_MAX_JOB_ATTEMPTS?: string;
  readonly WORDPRESS_RETRY_BASE_MS?: string;
  readonly WORDPRESS_RETRY_MAX_MS?: string;
}

function workerRole(value: string | undefined): "all" | "pipeline" | "inventory" {
  const normalized = value?.trim().toLocaleLowerCase("en-US") || "all";
  if (normalized !== "all" && normalized !== "pipeline" && normalized !== "inventory") {
    throw new Error("WORKER_ROLE must be all, pipeline or inventory");
  }
  return normalized;
}

function positiveInteger(environment: WorkerEnvironment, key: keyof WorkerEnvironment): number {
  const raw = environment[key];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

function positiveIntegerWithDefault(environment: WorkerEnvironment, key: keyof WorkerEnvironment, fallback: number): number {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
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

function preflightConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 8) {
    throw new Error("WORKER_PREFLIGHT_CONCURRENCY must be an integer from 1 to 8");
  }
  return parsed;
}

function classificationApplyConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 8) {
    throw new Error("WORKER_CLASSIFICATION_APPLY_CONCURRENCY must be an integer from 1 to 8");
  }
  return parsed;
}

function exportConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new Error("WORKER_EXPORT_CONCURRENCY must be an integer from 1 to 16");
  }
  return parsed;
}

function exportRefreshConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 4;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new Error("WORKER_EXPORT_REFRESH_CONCURRENCY must be an integer from 1 to 16");
  }
  return parsed;
}

export function loadWorkerConfig(environment: WorkerEnvironment = process.env): WorkerOptions {
  const workerId = environment.WORKER_ID?.trim();
  if (!workerId) throw new Error("WORKER_ID is required");
  const options = {
    workerId,
    role: workerRole(environment.WORKER_ROLE),
    pollIntervalMs: positiveInteger(environment, "WORKER_POLL_INTERVAL_MS"),
    lockTimeoutMs: positiveInteger(environment, "WORKER_LOCK_TIMEOUT_MS"),
    processConcurrency: processConcurrency(environment.WORKER_PROCESS_CONCURRENCY),
    translationConcurrency: processConcurrency(environment.WORKER_TRANSLATION_CONCURRENCY),
    collectionConcurrency: collectionConcurrency(environment.WORKER_COLLECTION_CONCURRENCY),
    preflightConcurrency: preflightConcurrency(environment.WORKER_PREFLIGHT_CONCURRENCY),
    classificationApplyConcurrency: classificationApplyConcurrency(environment.WORKER_CLASSIFICATION_APPLY_CONCURRENCY),
    exportConcurrency: exportConcurrency(environment.WORKER_EXPORT_CONCURRENCY),
    exportRefreshConcurrency: exportRefreshConcurrency(environment.WORKER_EXPORT_REFRESH_CONCURRENCY),
    inventoryRefreshConcurrency: collectionConcurrency(environment.WORKER_INVENTORY_REFRESH_CONCURRENCY),
    inventoryPrepareConcurrency: preflightConcurrency(environment.WORKER_INVENTORY_PREPARE_CONCURRENCY),
    inventorySubmitConcurrency: preflightConcurrency(environment.WORKER_INVENTORY_SUBMIT_CONCURRENCY),
    maxJobAttempts: positiveInteger(environment, "MAX_JOB_ATTEMPTS"),
    retryBaseMs: positiveInteger(environment, "JOB_RETRY_BASE_MS"),
    retryMaxMs: positiveInteger(environment, "JOB_RETRY_MAX_MS"),
    wordpressMaxJobAttempts: positiveIntegerWithDefault(environment, "WORDPRESS_MAX_JOB_ATTEMPTS", 12),
    wordpressRetryBaseMs: positiveIntegerWithDefault(environment, "WORDPRESS_RETRY_BASE_MS", 300_000),
    wordpressRetryMaxMs: positiveIntegerWithDefault(environment, "WORDPRESS_RETRY_MAX_MS", 3_600_000),
  };
  if (options.retryBaseMs > options.retryMaxMs) throw new Error("JOB_RETRY_BASE_MS must not exceed JOB_RETRY_MAX_MS");
  if (options.wordpressRetryBaseMs > options.wordpressRetryMaxMs) {
    throw new Error("WORDPRESS_RETRY_BASE_MS must not exceed WORDPRESS_RETRY_MAX_MS");
  }
  return options;
}
