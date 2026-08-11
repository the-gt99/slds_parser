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
  it("logs terminal cleanup failure while preserving the failed outcome", async () => { const failure = new PermanentError("business failed", { code: "BAD" }); const value = await setup(failure); value.handler.handleTerminalFailure = vi.fn().mockRejectedValue(new Error("cleanup failed")); const log = vi.fn(); const worker = new Worker(value.jobs, value.handler, options, async () => {}, Date.now, log); await worker.processNext(); expect(value.store.jobs.get(value.job.id)).toMatchObject({ status: "failed", lastError: "business failed" }); expect(log).toHaveBeenCalledWith(expect.stringContaining("cleanup failed")); expect(value.handler.dispatch).toHaveBeenCalledOnce(); });
  it("stops all lanes through AbortSignal", async () => { const value = await setup(); value.store.jobs.clear(); const controller = new AbortController(); const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => { controller.abort(); expect(signal.aborted).toBe(true); }); const worker = new Worker(value.jobs, value.handler, options, sleep); await worker.run(controller.signal); expect(sleep).toHaveBeenCalledOnce(); });
  it("claims only the job types assigned to a lane", async () => {
    const value = await setup();
    await value.jobs.enqueue({ jobType: "collect_product", payload: { sourceProductId: "2" }, uniqueKey: "two" });

    await value.worker.processNext(["collect_product"], "worker:general");

    expect([...value.store.jobs.values()].find((job) => job.jobType === "collect_product")).toMatchObject({ status: "completed", lockedBy: null });
    expect(value.store.jobs.get(value.job.id)?.status).toBe("pending");
  });

  it("runs the configured number of WordPress preflight lanes", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    for (let index = 1; index <= 3; index++) {
      await jobs.enqueue({
        jobType: "preflight_product",
        payload: { sourceProductId: String(index), targetId: "10" },
        uniqueKey: `preflight-${index}`,
      });
    }
    const controller = new AbortController();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const workerIds: string[] = [];
    const handler: JobHandler = {
      dispatch: vi.fn(async (job) => {
        workerIds.push(job.lockedBy ?? "");
        if (workerIds.length === 3) {
          release();
          controller.abort();
        }
        await barrier;
        return { status: "completed" as const };
      }),
      handleTerminalFailure: vi.fn(),
    };
    const sleep = async (_milliseconds: number, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    const worker = new Worker(jobs, handler, options, sleep, Date.now, console.error, undefined, async () => ({
      collectionConcurrency: 1,
      processConcurrency: 1,
      preflightConcurrency: 3,
    }));

    await worker.run(controller.signal);

    expect(workerIds.sort()).toEqual([
      "worker:preflight-1",
      "worker:preflight-2",
      "worker:preflight-3",
    ]);
  });

  it("processes only the explicitly selected job", async () => {
    const value = await setup();
    const second = await value.jobs.enqueue({ jobType: "process_product", payload: { sourceProductId: "2", force: true }, uniqueKey: "two" });

    const processed = await value.worker.processById(second.id, ["process_product"], "worker:manual");

    expect(processed).toBe(true);
    expect(value.store.jobs.get(second.id)).toMatchObject({ status: "completed", attempts: 1, lockedBy: null });
    expect(value.store.jobs.get(value.job.id)?.status).toBe("pending");
  });

  it("does not run a completed or disallowed exact job", async () => {
    const value = await setup();
    await value.jobs.complete(value.job.id);

    expect(await value.worker.processById(value.job.id, ["process_product"])).toBe(false);
    const collection = await value.jobs.enqueue({ jobType: "collect_product", payload: { sourceProductId: "2" }, uniqueKey: "two" });
    expect(await value.worker.processById(collection.id, ["process_product"])).toBe(false);
  });
});
