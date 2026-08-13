import { describe, expect, it, vi } from "vitest";
import type { SourceRepository, TargetRepository, WordPressCatalogRepository, WordPressCatalogRunRecord } from "../../src/repositories/index.js";
import { WordPressCatalogService } from "../../src/services/index.js";

function run(overrides: Partial<WordPressCatalogRunRecord> = {}): WordPressCatalogRunRecord {
  return {
    id: "1", targetId: "2", targetName: "WordPress", sourceCode: "goat", status: "completed",
    catalogCursor: "100", catalogComplete: true, auditRequested: true, variationSyncRequested: true,
    variationAutoStatus: "running", variationAutoWindow: 5_000, variationAutoAcknowledgedFailedCount: 0,
    variationAutoError: null, variationAutoStartedAt: "2026-08-13T00:00:00.000Z", variationAutoCompletedAt: null,
    actor: "admin", reason: null, lastError: null, createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z", completedAt: "2026-08-13T01:00:00.000Z",
    totalCount: 10_000, matchedCount: 9_000, unmatchedCount: 1_000, ambiguousCount: 0,
    variationPendingCount: 2_000, variationNotStartedCount: 6_000, variationSubmittedCount: 1_000,
    variationCompletedCount: 987, variationSkippedCount: 13, variationFailedCount: 0,
    auditPendingCount: 0, auditReadyCount: 7_000, auditBlockedCount: 2_000, auditErrorCount: 0,
    ...overrides,
  };
}

function setup(current: WordPressCatalogRunRecord | null) {
  const repository = {
    getRunningVariationAutoSync: vi.fn().mockResolvedValue(current === null ? null : {
      runId: current.id,
      window: current.variationAutoWindow,
      acknowledgedFailedCount: current.variationAutoAcknowledgedFailedCount,
      activeCount: current.variationPendingCount + current.variationSubmittedCount,
      failedCount: current.variationFailedCount,
    }),
    enqueueVariationBatch: vi.fn(async (_runId: string, limit: number) => Math.min(limit, current?.variationNotStartedCount ?? 0)),
    setVariationAutoSyncStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as WordPressCatalogRepository;
  const service = new WordPressCatalogService(
    repository,
    {} as SourceRepository,
    {} as TargetRepository,
  );
  return { repository, service };
}

describe("WordPressCatalogService variation auto-sync", () => {
  it("keeps only the free part of the configured window queued", async () => {
    const value = setup(run());

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(true);

    expect(value.repository.enqueueVariationBatch).toHaveBeenCalledWith("1", 2_000);
    expect(value.repository.setVariationAutoSyncStatus).not.toHaveBeenCalled();
  });

  it("does not replenish a full window", async () => {
    const value = setup(run({ variationPendingCount: 4_000, variationSubmittedCount: 1_000 }));

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(false);

    expect(value.repository.enqueueVariationBatch).not.toHaveBeenCalled();
  });

  it("pauses replenishment after a new hard failure", async () => {
    const value = setup(run({ variationFailedCount: 1 }));

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(true);

    expect(value.repository.enqueueVariationBatch).not.toHaveBeenCalled();
    expect(value.repository.setVariationAutoSyncStatus).toHaveBeenCalledWith(expect.objectContaining({
      runId: "1", status: "paused",
    }));
  });

  it("marks the flow completed after the final active jobs finish", async () => {
    const value = setup(run({ variationNotStartedCount: 0, variationPendingCount: 0, variationSubmittedCount: 0 }));

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(true);

    expect(value.repository.setVariationAutoSyncStatus).toHaveBeenCalledWith({ runId: "1", status: "completed" });
  });
});
