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
  it("uses one dedicated processing lane by default", () => {
    expect(loadWorkerConfig(environment).processConcurrency).toBe(1);
  });

  it("accepts a bounded processing concurrency", () => {
    expect(loadWorkerConfig({ ...environment, WORKER_PROCESS_CONCURRENCY: "3" }).processConcurrency).toBe(3);
    expect(() => loadWorkerConfig({ ...environment, WORKER_PROCESS_CONCURRENCY: "9" })).toThrow(
      "WORKER_PROCESS_CONCURRENCY must be an integer from 1 to 8",
    );
  });

  it("accepts a separately bounded collection concurrency", () => {
    expect(loadWorkerConfig({ ...environment, WORKER_COLLECTION_CONCURRENCY: "4" }).collectionConcurrency).toBe(4);
    expect(() => loadWorkerConfig({ ...environment, WORKER_COLLECTION_CONCURRENCY: "17" })).toThrow(
      "WORKER_COLLECTION_CONCURRENCY must be an integer from 1 to 16",
    );
  });
});
