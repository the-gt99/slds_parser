import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "../../src/config/index.js";

const environment = {
  WORKER_ID: "worker",
  WORKER_POLL_INTERVAL_MS: "1000",
  WORKER_LOCK_TIMEOUT_MS: "300000",
  MAX_JOB_ATTEMPTS: "5",
  JOB_RETRY_BASE_MS: "1000",
  JOB_RETRY_MAX_MS: "60000",
};

describe("worker config", () => {
  it("supports isolated pipeline and inventory workers", () => {
    expect(loadWorkerConfig(environment).role).toBe("all");
    expect(loadWorkerConfig({ ...environment, WORKER_ROLE: "pipeline" }).role).toBe("pipeline");
    expect(loadWorkerConfig({ ...environment, WORKER_ROLE: "inventory", WORKER_INVENTORY_REFRESH_CONCURRENCY: "3" }))
      .toMatchObject({ role: "inventory", inventoryRefreshConcurrency: 3 });
    expect(() => loadWorkerConfig({ ...environment, WORKER_ROLE: "unknown" })).toThrow(
      "WORKER_ROLE must be all, pipeline or inventory",
    );
  });
  it("uses one dedicated processing lane by default", () => {
    expect(loadWorkerConfig(environment).processConcurrency).toBe(1);
  });

  it("uses a long bounded retry policy for WordPress campaign requests", () => {
    expect(loadWorkerConfig(environment)).toMatchObject({
      wordpressMaxJobAttempts: 12,
      wordpressRetryBaseMs: 300_000,
      wordpressRetryMaxMs: 3_600_000,
    });
    expect(() => loadWorkerConfig({
      ...environment,
      WORDPRESS_RETRY_BASE_MS: "60000",
      WORDPRESS_RETRY_MAX_MS: "1000",
    })).toThrow("WORDPRESS_RETRY_BASE_MS must not exceed WORDPRESS_RETRY_MAX_MS");
  });

  it("accepts a bounded processing concurrency", () => {
    expect(loadWorkerConfig({ ...environment, WORKER_PROCESS_CONCURRENCY: "3" }).processConcurrency).toBe(3);
    expect(loadWorkerConfig({ ...environment, WORKER_PROCESS_CONCURRENCY: "15" }).processConcurrency).toBe(15);
    expect(() => loadWorkerConfig({ ...environment, WORKER_PROCESS_CONCURRENCY: "17" })).toThrow(
      "WORKER_PROCESS_CONCURRENCY must be an integer from 1 to 16",
    );
  });

  it("configures translation concurrency separately from processing", () => {
    expect(loadWorkerConfig(environment).translationConcurrency).toBe(1);
    expect(loadWorkerConfig({ ...environment, WORKER_PROCESS_CONCURRENCY: "10", WORKER_TRANSLATION_CONCURRENCY: "3" }).translationConcurrency).toBe(3);
  });

  it("accepts a separately bounded collection concurrency", () => {
    expect(loadWorkerConfig({ ...environment, WORKER_COLLECTION_CONCURRENCY: "4" }).collectionConcurrency).toBe(4);
    expect(() => loadWorkerConfig({ ...environment, WORKER_COLLECTION_CONCURRENCY: "17" })).toThrow(
      "WORKER_COLLECTION_CONCURRENCY must be an integer from 1 to 16",
    );
  });

  it("accepts a separately bounded WordPress preflight concurrency", () => {
    expect(loadWorkerConfig(environment).preflightConcurrency).toBe(1);
    expect(loadWorkerConfig({ ...environment, WORKER_PREFLIGHT_CONCURRENCY: "4" }).preflightConcurrency).toBe(4);
    expect(() => loadWorkerConfig({ ...environment, WORKER_PREFLIGHT_CONCURRENCY: "9" })).toThrow(
      "WORKER_PREFLIGHT_CONCURRENCY must be an integer from 1 to 8",
    );
  });

  it("allows the isolated inventory preparation lane to use sixteen workers", () => {
    expect(loadWorkerConfig({ ...environment, WORKER_INVENTORY_PREPARE_CONCURRENCY: "16" }).inventoryPrepareConcurrency).toBe(16);
    expect(() => loadWorkerConfig({ ...environment, WORKER_INVENTORY_PREPARE_CONCURRENCY: "17" })).toThrow(
      "WORKER_INVENTORY_PREPARE_CONCURRENCY must be an integer from 1 to 16",
    );
  });

  it("accepts a separately bounded WordPress classification apply concurrency", () => {
    expect(loadWorkerConfig(environment).classificationApplyConcurrency).toBe(1);
    expect(loadWorkerConfig({ ...environment, WORKER_CLASSIFICATION_APPLY_CONCURRENCY: "4" }).classificationApplyConcurrency).toBe(4);
    expect(() => loadWorkerConfig({ ...environment, WORKER_CLASSIFICATION_APPLY_CONCURRENCY: "9" })).toThrow(
      "WORKER_CLASSIFICATION_APPLY_CONCURRENCY must be an integer from 1 to 8",
    );
  });

  it("accepts a separately bounded export concurrency", () => {
    expect(loadWorkerConfig(environment).exportConcurrency).toBe(1);
    expect(loadWorkerConfig({ ...environment, WORKER_EXPORT_CONCURRENCY: "2" }).exportConcurrency).toBe(2);
    expect(loadWorkerConfig({ ...environment, WORKER_EXPORT_CONCURRENCY: "16" }).exportConcurrency).toBe(16);
    expect(() => loadWorkerConfig({ ...environment, WORKER_EXPORT_CONCURRENCY: "17" })).toThrow(
      "WORKER_EXPORT_CONCURRENCY must be an integer from 1 to 16",
    );
  });
});
