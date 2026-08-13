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

function setup(current: WordPressCatalogRunRecord | null, outcome: "idle" | "waiting" | "queued" | "paused" | "completed" = "queued") {
  const repository = {
    getRunningVariationAutoSync: vi.fn().mockResolvedValue(current === null ? null : {
      runId: current.id,
      window: current.variationAutoWindow,
      acknowledgedFailedCount: current.variationAutoAcknowledgedFailedCount,
      activeCount: current.variationPendingCount + current.variationSubmittedCount,
      failedCount: current.variationFailedCount,
    }),
    replenishVariationAutoSync: vi.fn().mockResolvedValue(outcome),
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
  it("reports a replenished window as work", async () => {
    const value = setup(run(), "queued");

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(true);

    expect(value.repository.replenishVariationAutoSync).toHaveBeenCalledOnce();
  });

  it("reports a full window as waiting", async () => {
    const value = setup(run(), "waiting");

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(false);
  });

  it("reports an automatic pause as work", async () => {
    const value = setup(run(), "paused");

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(true);
  });

  it("reports completion as work", async () => {
    const value = setup(run(), "completed");

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(true);
  });
});
