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

  it("holds reclassification until bulk rule application is complete", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    const reclassify = await jobs.enqueue({ jobType: "reclassify_product", payload: { sourceProductId: "1" }, uniqueKey: "reclassify-1" });
    const application = await jobs.enqueue({ jobType: "apply_target_classification_suggestion", payload: { runId: "1", suggestionId: "1", actor: "admin" }, uniqueKey: "apply-1" });

    expect(await jobs.claimNext("worker", 100, ["reclassify_product"])).toBeNull();
    expect(await jobs.claimById(application.id, "worker:apply", ["apply_target_classification_suggestion"])).not.toBeNull();
    await jobs.complete(application.id);

    expect(await jobs.claimNext("worker", 100, ["reclassify_product"])).toMatchObject({ id: reclassify.id });
  });

  it("claims and completes reclassification jobs in a bounded batch", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    for (let index = 1; index <= 20; index += 1) {
      await jobs.enqueue({ jobType: "reclassify_product", payload: { sourceProductId: String(index) }, uniqueKey: `reclassify-${index}` });
    }
    const handler: JobHandler = { dispatch: vi.fn().mockResolvedValue({ status: "completed" }), handleTerminalFailure: vi.fn() };
    const worker = new Worker(jobs, handler, options);

    expect(await worker.processMany("reclassify_product", "worker:process-1", 16)).toBe(true);
    expect([...store.jobs.values()].filter((job) => job.status === "completed")).toHaveLength(16);
    expect([...store.jobs.values()].filter((job) => job.status === "pending")).toHaveLength(4);
  });

  it("polls one hundred WordPress variation jobs with one request", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    for (let index = 1; index <= 100; index += 1) {
      await jobs.enqueue({
        jobType: "poll_wordpress_variation_patches",
        payload: { runId: "1", jobIds: [String(index)], poll: 2 },
        uniqueKey: `poll-${index}`,
      });
    }
    const handler: JobHandler = { dispatch: vi.fn().mockResolvedValue({ status: "completed" }), handleTerminalFailure: vi.fn() };
    const worker = new Worker(jobs, handler, options);

    expect(await worker.processWordPressVariationPollBatch("worker:poll")).toBe(true);
    expect(handler.dispatch).toHaveBeenCalledOnce();
    expect(vi.mocked(handler.dispatch).mock.calls[0]?.[0]).toMatchObject({
      jobType: "poll_wordpress_variation_patches",
      payload: { runId: "1", poll: 2 },
    });
    expect((vi.mocked(handler.dispatch).mock.calls[0]?.[0].payload as { jobIds: string[] }).jobIds).toHaveLength(100);
    expect([...store.jobs.values()].filter((job) => job.status === "completed")).toHaveLength(100);
  });

  it("keeps WordPress variation poll runs in separate requests", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    await jobs.enqueue({ jobType: "poll_wordpress_variation_patches", payload: { runId: "1", jobIds: ["11"], poll: 0 }, uniqueKey: "poll-1" });
    await jobs.enqueue({ jobType: "poll_wordpress_variation_patches", payload: { runId: "2", jobIds: ["22"], poll: 0 }, uniqueKey: "poll-2" });
    const handler: JobHandler = { dispatch: vi.fn().mockResolvedValue({ status: "completed" }), handleTerminalFailure: vi.fn() };
    const worker = new Worker(jobs, handler, options);

    await worker.processWordPressVariationPollBatch("worker:poll");

    expect(handler.dispatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(handler.dispatch).mock.calls.map(([job]) => job.payload)).toEqual([
      { runId: "1", jobIds: ["11"], poll: 0 },
      { runId: "2", jobIds: ["22"], poll: 0 },
    ]);
  });

  it("keeps WordPress variation poll counters in separate requests", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    await jobs.enqueue({ jobType: "poll_wordpress_variation_patches", payload: { runId: "1", jobIds: ["11"], poll: 1 }, uniqueKey: "poll-1" });
    await jobs.enqueue({ jobType: "poll_wordpress_variation_patches", payload: { runId: "1", jobIds: ["22"], poll: 719 }, uniqueKey: "poll-2" });
    const handler: JobHandler = { dispatch: vi.fn().mockResolvedValue({ status: "completed" }), handleTerminalFailure: vi.fn() };
    const worker = new Worker(jobs, handler, options);

    await worker.processWordPressVariationPollBatch("worker:poll");

    expect(handler.dispatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(handler.dispatch).mock.calls.map(([job]) => job.payload)).toEqual([
      { runId: "1", jobIds: ["11"], poll: 1 },
      { runId: "1", jobIds: ["22"], poll: 719 },
    ]);
  });

  it("does not exceed the WordPress limit of five hundred job ids per poll", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    await jobs.enqueue({
      jobType: "poll_wordpress_variation_patches",
      payload: { runId: "1", jobIds: Array.from({ length: 300 }, (_, index) => String(index + 1)), poll: 1 },
      uniqueKey: "poll-1",
    });
    await jobs.enqueue({
      jobType: "poll_wordpress_variation_patches",
      payload: { runId: "1", jobIds: Array.from({ length: 250 }, (_, index) => String(index + 301)), poll: 1 },
      uniqueKey: "poll-2",
    });
    const handler: JobHandler = { dispatch: vi.fn().mockResolvedValue({ status: "completed" }), handleTerminalFailure: vi.fn() };
    const worker = new Worker(jobs, handler, options);

    await worker.processWordPressVariationPollBatch("worker:poll");

    expect(handler.dispatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(handler.dispatch).mock.calls.map(([job]) => (job.payload as { jobIds: string[] }).jobIds.length)).toEqual([300, 250]);
  });

  it("preserves retry state for every job in a failed WordPress poll batch", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    await jobs.enqueue({ jobType: "poll_wordpress_variation_patches", payload: { runId: "1", jobIds: ["11"], poll: 0 }, uniqueKey: "poll-1" });
    await jobs.enqueue({ jobType: "poll_wordpress_variation_patches", payload: { runId: "1", jobIds: ["22"], poll: 0 }, uniqueKey: "poll-2" });
    const handler: JobHandler = { dispatch: vi.fn().mockRejectedValue(new RetryableError("later", { code: "LATER" })), handleTerminalFailure: vi.fn() };
    const worker = new Worker(jobs, handler, options, async () => {}, () => Date.parse("2026-01-01T00:00:00.000Z"));

    await worker.processWordPressVariationPollBatch("worker:poll");

    expect([...store.jobs.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ uniqueKey: "poll-1", status: "retry", availableAt: "2026-01-01T00:00:01.000Z" }),
      expect.objectContaining({ uniqueKey: "poll-2", status: "retry", availableAt: "2026-01-01T00:00:01.000Z" }),
    ]));
    expect(handler.handleTerminalFailure).not.toHaveBeenCalled();
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
      classificationApplyConcurrency: 1,
    }));

    await worker.run(controller.signal);

    expect(workerIds.sort()).toEqual([
      "worker:preflight-1",
      "worker:preflight-2",
      "worker:preflight-3",
    ]);
  });

  it("runs the configured number of local WordPress audit lanes", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    for (let index = 1; index <= 3; index++) {
      await jobs.enqueue({
        jobType: "prepare_wordpress_variation_patches",
        payload: { runId: "1", afterCursor: String(index - 1), throughCursor: String(index) },
        uniqueKey: `wordpress-audit-${index}`,
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
      classificationApplyConcurrency: 1,
    }));

    await worker.run(controller.signal);

    expect(workerIds.sort()).toEqual([
      "worker:wordpress-audit-1",
      "worker:wordpress-audit-2",
      "worker:wordpress-audit-3",
    ]);
  });

  it("runs the configured number of WordPress classification apply lanes", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    for (let index = 1; index <= 4; index++) {
      await jobs.enqueue({
        jobType: "apply_target_classification_suggestion",
        payload: { runId: "1", suggestionId: String(index), actor: "admin" },
        uniqueKey: `apply-${index}`,
      });
    }
    const controller = new AbortController();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const workerIds: string[] = [];
    const handler: JobHandler = {
      dispatch: vi.fn(async (job) => {
        workerIds.push(job.lockedBy ?? "");
        if (workerIds.length === 4) {
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
      preflightConcurrency: 1,
      classificationApplyConcurrency: 4,
    }));

    await worker.run(controller.signal);

    expect(workerIds.sort()).toEqual([
      "worker:classification-apply-1",
      "worker:classification-apply-2",
      "worker:classification-apply-3",
      "worker:classification-apply-4",
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
