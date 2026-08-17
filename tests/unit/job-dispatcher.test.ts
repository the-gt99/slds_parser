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
    ["reclassify_product", { sourceProductId: "1" }, "reclassifyProduct"],
    ["export_product", { internalProductId: "1", targetId: "2", force: false }, "exportProduct"],
  ] as const)("routes %s", async (type, payload, method) => {
    const collection = { discoverSource: vi.fn().mockResolvedValue({ status: "completed" }), collectProduct: vi.fn().mockResolvedValue({ status: "completed" }) };
    const processing = { processProduct: vi.fn().mockResolvedValue({ status: "completed" }), reclassifyProduct: vi.fn().mockResolvedValue({ status: "completed" }) }; const exports = { exportProduct: vi.fn().mockResolvedValue({ status: "completed" }) };
    const repositories = createMemoryRepositories(new MemoryStore()); const dispatcher = new JobDispatcher(collection as never, processing as never, exports as never, repositories.sourceRuns);
    await dispatcher.dispatch(job(type, payload)); const owner = method === "processProduct" || method === "reclassifyProduct" ? processing : method === "exportProduct" ? exports : collection; expect(owner[method as keyof typeof owner]).toHaveBeenCalledOnce();
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
  it("routes translation-only jobs", async () => {
    const repositories = createMemoryRepositories(new MemoryStore());
    const retranslations = { retranslateProduct: vi.fn().mockResolvedValue({ status: "completed" }) };
    const dispatcher = new JobDispatcher({} as never, {} as never, {} as never, repositories.sourceRuns,
      undefined, undefined, undefined, undefined, undefined, undefined, retranslations as never);

    await dispatcher.dispatch(job("retranslate_product", { sourceProductId: "42" }));

    expect(retranslations.retranslateProduct).toHaveBeenCalledWith({ sourceProductId: "42" });
  });
  it("routes queued WordPress classification suggestions and releases terminal failures", async () => {
    const repositories = createMemoryRepositories(new MemoryStore());
    const classificationApply = {
      apply: vi.fn().mockResolvedValue({ status: "completed" }),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const dispatcher = new JobDispatcher({} as never, {} as never, {} as never, repositories.sourceRuns,
      undefined, undefined, undefined, classificationApply as never);
    const value = job("apply_target_classification_suggestion", { runId: "1", suggestionId: "2", actor: "admin" });

    await dispatcher.dispatch(value);
    await dispatcher.handleTerminalFailure(value, new Error("failed"));

    expect(classificationApply.apply).toHaveBeenCalledWith({ runId: "1", suggestionId: "2", actor: "admin" });
    expect(classificationApply.fail).toHaveBeenCalledWith({ runId: "1", suggestionId: "2", actor: "admin" }, "failed");
  });
  it("rejects an invalid payload", async () => { const repositories = createMemoryRepositories(new MemoryStore()); const dispatcher = new JobDispatcher({} as never, {} as never, {} as never, repositories.sourceRuns); await expect(dispatcher.dispatch(job("process_product", { sourceProductId: 1, force: false }))).rejects.toBeInstanceOf(InvalidJobPayloadError); });
});
