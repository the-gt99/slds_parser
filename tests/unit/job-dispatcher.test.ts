import { describe, expect, it, vi } from "vitest";
import { JobDispatcher } from "../../src/application/index.js";
import { InvalidJobPayloadError } from "../../src/core/errors/index.js";
import type { JobRecord, JobType } from "../../src/repositories/index.js";
import { createMemoryRepositories, MemoryStore } from "../support/in-memory.js";

function job(jobType: JobType, payload: JobRecord["payload"]): JobRecord { return { id: "1", jobType, payload, status: "running", attempts: 1, availableAt: "2026-01-01T00:00:00.000Z", lockedAt: null, lockedBy: null, uniqueKey: "key", lastError: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", finishedAt: null }; }

describe("JobDispatcher", () => {
  it.each([
    ["discover_source", { sourceId: "1", runType: "full", coverage: "catalog" }, "discoverSource"],
    ["collect_product", { sourceProductId: "1", requestedPartKeys: ["details"] }, "collectProduct"],
    ["process_product", { sourceProductId: "1", force: false }, "processProduct"],
    ["export_product", { internalProductId: "1", targetId: "2", force: false }, "exportProduct"],
  ] as const)("routes %s", async (type, payload, method) => {
    const collection = { discoverSource: vi.fn().mockResolvedValue({ status: "completed" }), collectProduct: vi.fn().mockResolvedValue({ status: "completed" }) };
    const processing = { processProduct: vi.fn().mockResolvedValue({ status: "completed" }) }; const exports = { exportProduct: vi.fn().mockResolvedValue({ status: "completed" }) };
    const repositories = createMemoryRepositories(new MemoryStore()); const dispatcher = new JobDispatcher(collection as never, processing as never, exports as never, repositories.sourceRuns);
    await dispatcher.dispatch(job(type, payload)); const owner = method === "processProduct" ? processing : method === "exportProduct" ? exports : collection; expect(owner[method as keyof typeof owner]).toHaveBeenCalledOnce();
  });
  it("routes preflight jobs and records their terminal error", async () => {
    const collection = {};
    const processing = {};
    const exports = {};
    const preflights = { preflightProduct: vi.fn().mockResolvedValue({ status: "completed" }) };
    const exportControl = { savePreflightError: vi.fn().mockResolvedValue(undefined) };
    const repositories = createMemoryRepositories(new MemoryStore());
    const dispatcher = new JobDispatcher(collection as never, processing as never, exports as never,
      repositories.sourceRuns, preflights as never, exportControl as never);
    const value = job("preflight_product", { sourceProductId: "1", targetId: "2" });

    await dispatcher.dispatch(value);
    await dispatcher.handleTerminalFailure(value, new Error("lookup failed"));

    expect(preflights.preflightProduct).toHaveBeenCalledWith({ sourceProductId: "1", targetId: "2" });
    expect(exportControl.savePreflightError).toHaveBeenCalledWith({
      sourceProductId: "1",
      targetId: "2",
      error: "lookup failed",
    });
  });
  it("records a terminal export-refresh failure", async () => {
    const exportControl = { savePreparationError: vi.fn().mockResolvedValue(undefined) };
    const repositories = createMemoryRepositories(new MemoryStore());
    const dispatcher = new JobDispatcher({} as never, {} as never, {} as never,
      repositories.sourceRuns, undefined, exportControl as never);
    const value = job("collect_product", { sourceProductId: "1", refreshForExport: true, enqueueProcessing: true });

    await dispatcher.handleTerminalFailure(value, new Error("GOAT unavailable"));

    expect(exportControl.savePreparationError).toHaveBeenCalledWith({
      sourceProductId: "1",
      phase: "source_refresh",
      error: "GOAT unavailable",
    });
  });
  it("rejects an invalid payload", async () => { const repositories = createMemoryRepositories(new MemoryStore()); const dispatcher = new JobDispatcher({} as never, {} as never, {} as never, repositories.sourceRuns); await expect(dispatcher.dispatch(job("process_product", { sourceProductId: 1, force: false }))).rejects.toBeInstanceOf(InvalidJobPayloadError); });
});
