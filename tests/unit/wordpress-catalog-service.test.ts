import { describe, expect, it, vi } from "vitest";
import type { SourceRepository, TargetRepository, WordPressCatalogRepository, WordPressCatalogRunRecord } from "../../src/repositories/index.js";
import { WordPressCatalogService } from "../../src/services/index.js";

function run(overrides: Partial<WordPressCatalogRunRecord> = {}): WordPressCatalogRunRecord {
  return {
    id: "1", targetId: "2", targetName: "WordPress", sourceCode: "goat", status: "completed",
    catalogCursor: "100", catalogComplete: true, auditRequested: true, variationSyncRequested: true,
    variationAutoStatus: "running", variationAutoWindow: 5_000, variationAutoAcknowledgedFailedCount: 0,
    variationAutoError: null, variationAutoStartedAt: "2026-08-13T00:00:00.000Z", variationAutoCompletedAt: null,
    variationSyncIntervalMinutes: 360, variationSyncCycle: 2,
    variationSyncLastCycleStartedAt: "2026-08-13T00:00:00.000Z",
    variationSyncLastCycleCompletedAt: null, variationSyncNextCycleAt: null,
    actor: "admin", reason: null, lastError: null, createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z", completedAt: "2026-08-13T01:00:00.000Z",
    totalCount: 10_000, matchedCount: 9_000, unmatchedCount: 1_000, ambiguousCount: 0,
    variationPendingCount: 2_000, variationNotStartedCount: 6_000, variationSubmittedCount: 1_000,
    variationCompletedCount: 987, variationSkippedCount: 13, variationFailedCount: 0,
    auditPendingCount: 0, auditReadyCount: 7_000, auditBlockedCount: 2_000, auditErrorCount: 0,
    ...overrides,
  };
}

function setup(current: WordPressCatalogRunRecord | null, outcome: "idle" | "waiting" | "queued" | "paused" | "cycle_completed" | "cycle_started" = "queued") {
  const repository = {
    getActiveVariationSync: vi.fn().mockResolvedValue(current === null ? null : {
      runId: current.id,
      window: current.variationAutoWindow,
      acknowledgedFailedCount: current.variationAutoAcknowledgedFailedCount,
      activeCount: current.variationPendingCount + current.variationSubmittedCount,
      failedCount: current.variationFailedCount,
      intervalMinutes: current.variationSyncIntervalMinutes,
      cycle: current.variationSyncCycle,
      nextCycleAt: current.variationSyncNextCycleAt,
    }),
    enqueueReadyVariationBatches: vi.fn().mockResolvedValue(0),
    replenishVariationAutoSync: vi.fn().mockResolvedValue(outcome),
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
  it("starts a continuous schedule with a bounded interval", async () => {
    const current = run({ variationAutoStatus: "inactive", variationPendingCount: 0, variationSubmittedCount: 0 });
    const value = setup(current);
    value.repository.getRun = vi.fn().mockResolvedValue(current);
    value.repository.startVariationAutoSync = vi.fn().mockResolvedValue(undefined);

    await expect(value.service.startVariationAutoSync("1", 100, 360)).resolves.toEqual(current);
    expect(value.repository.startVariationAutoSync).toHaveBeenCalledWith("1", 100, 360);
  });

  it("rejects an unsafe schedule interval", async () => {
    const current = run({ variationAutoStatus: "inactive" });
    const value = setup(current);
    value.repository.getRun = vi.fn().mockResolvedValue(current);

    await expect(value.service.startVariationAutoSync("1", 100, 1)).rejects.toThrow("Интервал обновления");
  });

  it("stops a running continuous schedule", async () => {
    const current = run();
    const stopped = run({ variationAutoStatus: "inactive" });
    const value = setup(current);
    value.repository.getRun = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(stopped);

    await expect(value.service.stopVariationAutoSync("1")).resolves.toEqual(stopped);
    expect(value.repository.setVariationAutoSyncStatus).toHaveBeenCalledWith({ runId: "1", status: "inactive" });
  });

  it("reports a replenished window as work", async () => {
    const value = setup(run(), "queued");

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(true);

    expect(value.repository.replenishVariationAutoSync).toHaveBeenCalledOnce();
  });

  it("submits ready variation patches in full API batches", async () => {
    const value = setup(run(), "waiting");
    value.repository.enqueueReadyVariationBatches = vi.fn().mockResolvedValue(20);

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(true);

    expect(value.repository.enqueueReadyVariationBatches).toHaveBeenCalledWith("1", 100);
    expect(value.repository.replenishVariationAutoSync).not.toHaveBeenCalled();
  });

  it("reports a full window as waiting", async () => {
    const value = setup(run(), "waiting");

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(false);
  });

  it("reports an automatic pause as work", async () => {
    const value = setup(run(), "paused");

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(true);
  });

  it("reports a completed cycle as work", async () => {
    const value = setup(run(), "cycle_completed");

    await expect(value.service.tickVariationAutoSync()).resolves.toBe(true);
  });
});

describe("WordPressCatalogService blocked audit retry", () => {
  it("queues blocked items from a completed audited catalog", async () => {
    const repository = {
      getRun: vi.fn().mockResolvedValue(run()),
      retryBlockedAudits: vi.fn().mockResolvedValue({ queuedItemCount: 2_000, queuedJobCount: 4 }),
    } as unknown as WordPressCatalogRepository;
    const service = new WordPressCatalogService(repository, {} as SourceRepository, {} as TargetRepository);

    await expect(service.retryBlockedAudits("1")).resolves.toEqual({ queuedItemCount: 2_000, queuedJobCount: 4 });
    expect(repository.retryBlockedAudits).toHaveBeenCalledWith("1");
  });

  it("rejects retry before the catalog snapshot is complete", async () => {
    const repository = {
      getRun: vi.fn().mockResolvedValue(run({ catalogComplete: false })),
      retryBlockedAudits: vi.fn(),
    } as unknown as WordPressCatalogRepository;
    const service = new WordPressCatalogService(repository, {} as SourceRepository, {} as TargetRepository);

    await expect(service.retryBlockedAudits("1")).rejects.toThrow("Повторный аудит доступен только для завершённого снимка");
    expect(repository.retryBlockedAudits).not.toHaveBeenCalled();
  });
});

describe("WordPressCatalogService audit rebuild", () => {
  it("queues only audits matching the requested saved change flag", async () => {
    const repository = {
      getRun: vi.fn().mockResolvedValue(run()),
      rebuildAudits: vi.fn().mockResolvedValue({ queuedItemCount: 3_780, queuedJobCount: 8 }),
    } as unknown as WordPressCatalogRepository;
    const service = new WordPressCatalogService(repository, {} as SourceRepository, {} as TargetRepository);

    await expect(service.rebuildAudits("4", " taxonomy_removed:pa_model ")).resolves.toEqual({
      queuedItemCount: 3_780,
      queuedJobCount: 8,
    });
    expect(repository.rebuildAudits).toHaveBeenCalledWith("4", "taxonomy_removed:pa_model");
  });

  it("rejects rebuild before the catalog snapshot is complete", async () => {
    const repository = {
      getRun: vi.fn().mockResolvedValue(run({ catalogComplete: false })),
      rebuildAudits: vi.fn(),
    } as unknown as WordPressCatalogRepository;
    const service = new WordPressCatalogService(repository, {} as SourceRepository, {} as TargetRepository);

    await expect(service.rebuildAudits("4")).rejects.toThrow("Пересчёт аудита доступен только для завершённого снимка");
    expect(repository.rebuildAudits).not.toHaveBeenCalled();
  });
});
