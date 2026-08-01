import { describe, expect, it, vi } from "vitest";
import { Worker, type JobHandler } from "../../src/application/index.js";
import { PermanentError, RetryableError } from "../../src/core/errors/index.js";
import { MemoryJobRepository, MemoryStore } from "../support/in-memory.js";

const options = { workerId: "worker", pollIntervalMs: 1, lockTimeoutMs: 100, maxJobAttempts: 3, retryBaseMs: 1000, retryMaxMs: 2500 };
async function setup(error?: unknown, attempts = 0) {
  const store = new MemoryStore(); const jobs = new MemoryJobRepository(store); const job = await jobs.enqueue({ jobType: "process_product", payload: { sourceProductId: "1", force: false }, uniqueKey: "one" });
  store.jobs.set(job.id, { ...job, attempts }); const handler: JobHandler = { dispatch: error === undefined ? vi.fn().mockResolvedValue({ status: "completed" }) : vi.fn().mockRejectedValue(error), handleTerminalFailure: vi.fn() };
  return { store, jobs, job, handler, worker: new Worker(jobs, handler, options, async () => {}, () => Date.parse("2026-01-01T00:00:00.000Z")) };
}

describe("Worker", () => {
  it("completes a successful job", async () => { const value = await setup(); await value.worker.processNext(); expect(value.store.jobs.get(value.job.id)?.status).toBe("completed"); });
  it("retries only RetryableError with exponential capped backoff", async () => { const value = await setup(new RetryableError("later", { code: "LATER" }), 2); await value.worker.processNext(); expect(value.store.jobs.get(value.job.id)).toMatchObject({ status: "failed" }); const retry = await setup(new RetryableError("later", { code: "LATER" }), 1); await retry.worker.processNext(); expect(retry.store.jobs.get(retry.job.id)).toMatchObject({ status: "retry", availableAt: "2026-01-01T00:00:02.000Z" }); });
  it.each([new PermanentError("bad", { code: "BAD" }), new Error("bug")])("fails terminal error %#", async (error) => { const value = await setup(error); await value.worker.processNext(); expect(value.store.jobs.get(value.job.id)?.status).toBe("failed"); expect(value.handler.handleTerminalFailure).toHaveBeenCalledOnce(); });
  it("stops its loop through AbortSignal", async () => { const value = await setup(); value.store.jobs.clear(); const controller = new AbortController(); const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => { controller.abort(); expect(signal).toBe(controller.signal); }); const worker = new Worker(value.jobs, value.handler, options, sleep); await worker.run(controller.signal); expect(sleep).toHaveBeenCalledOnce(); });
});
