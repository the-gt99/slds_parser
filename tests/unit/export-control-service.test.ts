import { describe, expect, it, vi } from "vitest";

import { ExportControlService } from "../../src/services/index.js";
import type { ExportControlExportCandidate, ExportControlRepository, JobRepository } from "../../src/repositories/index.js";

const candidate: ExportControlExportCandidate = {
  reviewId: "11",
  sourceProductId: "21",
  internalProductId: "31",
  payloadHash: "a".repeat(64),
  willCreate: false,
  externalId: "41",
  matchedBy: "source_identity",
  riskLevel: "danger",
  changeFlags: ["taxonomy_removed:product_tag"],
  wordpressStateHash: "b".repeat(64),
};

function setup() {
  const repository = {
    preparePreflightCandidates: vi.fn().mockResolvedValue([{ sourceProductId: "21", internalProductId: "31", refreshWordPress: true }]),
    listExportCandidates: vi.fn().mockResolvedValue([candidate]),
    createBatch: vi.fn().mockResolvedValue({
      batchId: "51",
      items: [{ id: "61", sourceProductId: "21", internalProductId: "31" }],
      jobIds: ["71"],
    }),
    createCampaign: vi.fn().mockImplementation(async (input) => ({
      id: "81", targetId: input.targetId, status: "running", actor: input.actor,
      reason: input.reason ?? null, mode: input.mode, catalogRunId: input.catalogRunId ?? null,
      preflightWindow: input.preflightWindow, maxExports: input.maxExports ?? null,
      itemCount: 0, pendingCount: 0, retryCount: 0, runningCount: 0, completedCount: 0, failedCount: 0,
      acknowledgedFailedCount: 0, activePreflightCount: 0, scanBeforeInternalProductId: null,
      scanComplete: false, lastError: null, createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z", pausedAt: null, completedAt: null,
    })),
    getRunningCampaign: vi.fn().mockResolvedValue(null),
    countActivePreflights: vi.fn().mockResolvedValue(0),
    prepareCampaignPreflightCandidates: vi.fn().mockResolvedValue([{ sourceProductId: "21", internalProductId: "31", refreshWordPress: true }]),
    setCampaignStatus: vi.fn(),
  } as unknown as ExportControlRepository;
  const jobs = {
    enqueueMany: vi.fn(async (inputs: readonly { readonly uniqueKey: string }[]) => inputs.map((input, index) => ({
      id: String(71 + index),
      uniqueKey: input.uniqueKey,
    }))),
  } as unknown as JobRepository;
  return { repository, jobs, service: new ExportControlService(repository, jobs) };
}

describe("ExportControlService", () => {
  it("queues only the bounded preflight candidates selected by the repository", async () => {
    const { repository, jobs, service } = setup();

    await expect(service.enqueuePreflights({ targetId: "10", limit: 50 })).resolves.toEqual({
      queuedCount: 1,
      sourceProductIds: ["21"],
      jobIds: ["71"],
    });
    expect(repository.preparePreflightCandidates).toHaveBeenCalledWith({ targetId: "10", limit: 50 });
    expect(jobs.enqueueMany).toHaveBeenCalledWith([{
      jobType: "preflight_product",
      payload: { sourceProductId: "21", targetId: "10", refreshWordPress: true },
      uniqueKey: "target-product:10:21:preflight",
    }]);
  });

  it("requests only stale reviewed products for automatic maintenance", async () => {
    const { repository, service } = setup();

    await service.enqueuePreflights({ targetId: "10", mode: "stale", limit: 100 });

    expect(repository.preparePreflightCandidates).toHaveBeenCalledWith({ targetId: "10", mode: "stale", limit: 100 });
  });

  it("delegates the frozen approval and export jobs to one atomic batch creation", async () => {
    const { repository, jobs, service } = setup();

    await expect(service.applyExport({ targetId: "10", sourceProductIds: ["21"], reason: "smoke" }, "admin"))
      .resolves.toEqual({ batchId: "51", queuedCount: 1, jobIds: ["71"] });
    expect(repository.createBatch).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "10",
      actor: "admin",
      reason: "smoke",
      candidates: [candidate],
    }));
    expect(jobs.enqueueMany).not.toHaveBeenCalled();
  });

  it("streams one safe update at a time and keeps the preflight window full", async () => {
    const { repository, jobs, service } = setup();
    vi.mocked(repository.listExportCandidates).mockResolvedValue([{ ...candidate, riskLevel: "none" }]);
    vi.mocked(repository.getRunningCampaign).mockResolvedValue({
      id: "81", targetId: "10", status: "running", actor: "admin", reason: "mass",
      mode: "safe", catalogRunId: null,
      preflightWindow: 25, maxExports: 100, itemCount: 3, pendingCount: 0, retryCount: 0, runningCount: 0,
      completedCount: 3, failedCount: 0, acknowledgedFailedCount: 0, activePreflightCount: 5,
      scanBeforeInternalProductId: null, scanComplete: false,
      lastError: null, createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z",
      pausedAt: null, completedAt: null,
    });
    vi.mocked(repository.countActivePreflights).mockResolvedValue(5);

    await service.tickCampaign();

    expect(repository.listExportCandidates).toHaveBeenCalledWith({
      targetId: "10",
      filter: { status: "ready", operation: "update", riskLevel: "none" },
      limit: 1,
      campaignId: "81",
      excludeNoChanges: true,
    });
    expect(repository.createBatch).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "81",
      candidates: [{ ...candidate, riskLevel: "none" }],
    }));
    expect(repository.prepareCampaignPreflightCandidates).toHaveBeenCalledWith({ campaignId: "81", limit: 20 });
    expect(jobs.enqueueMany).toHaveBeenCalledWith([{
      jobType: "preflight_product",
      payload: { sourceProductId: "21", targetId: "10", refreshWordPress: true },
      uniqueKey: "target-product:10:21:preflight",
    }]);
  });

  it("streams reviewed and dangerous updates only inside a selected WordPress catalog", async () => {
    const { repository, service } = setup();
    vi.mocked(repository.getRunningCampaign).mockResolvedValue({
      id: "82", targetId: "10", status: "running", actor: "admin", reason: "full",
      mode: "full_existing", catalogRunId: "4", preflightWindow: 25, maxExports: 250_000,
      itemCount: 0, pendingCount: 0, retryCount: 0, runningCount: 0, completedCount: 0, failedCount: 0,
      acknowledgedFailedCount: 0, activePreflightCount: 0, scanBeforeInternalProductId: null,
      scanComplete: false, lastError: null, createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z", pausedAt: null, completedAt: null,
    });
    vi.mocked(repository.countActivePreflights).mockResolvedValue(0);

    await service.tickCampaign();

    expect(repository.listExportCandidates).toHaveBeenCalledWith({
      targetId: "10",
      filter: { status: "ready", operation: "update" },
      limit: 1,
      campaignId: "82",
      excludeNoChanges: true,
    });
    expect(repository.createBatch).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "82",
      candidates: [candidate],
    }));
  });

  it("requires a completed WordPress catalog scope for full existing campaigns", async () => {
    const { repository, service } = setup();

    await expect(service.startCampaign({ targetId: "10", mode: "full_existing" }, "admin"))
      .rejects.toThrow("снимок каталога WordPress");
    await service.startCampaign({
      targetId: "10", mode: "full_existing", catalogRunId: "4", maxExports: 250_000,
    }, "admin");

    expect(repository.createCampaign).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "10", actor: "admin", mode: "full_existing", catalogRunId: "4",
      maxExports: 250_000,
    }));
  });

  it("continues with the next product after a terminal product failure", async () => {
    const { repository, service } = setup();
    vi.mocked(repository.getRunningCampaign).mockResolvedValue({
      id: "83", targetId: "10", status: "running", actor: "admin", reason: "mass",
      mode: "full_existing", catalogRunId: "4", preflightWindow: 25, maxExports: 250_000,
      itemCount: 4, pendingCount: 0, retryCount: 0, runningCount: 0, completedCount: 3,
      failedCount: 1, acknowledgedFailedCount: 0, activePreflightCount: 0,
      scanBeforeInternalProductId: null, scanComplete: false, lastError: null,
      createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z",
      pausedAt: null, completedAt: null,
    });

    await service.tickCampaign();

    expect(repository.setCampaignStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }));
    expect(repository.createBatch).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "83",
      candidates: [candidate],
    }));
  });

  it("does not let a delayed WordPress retry block the next product", async () => {
    const { repository, service } = setup();
    vi.mocked(repository.getRunningCampaign).mockResolvedValue({
      id: "84", targetId: "10", status: "running", actor: "admin", reason: "mass",
      mode: "full_existing", catalogRunId: "4", preflightWindow: 25, maxExports: 250_000,
      itemCount: 4, pendingCount: 0, retryCount: 1, runningCount: 0, completedCount: 3,
      failedCount: 0, acknowledgedFailedCount: 0, activePreflightCount: 0,
      scanBeforeInternalProductId: null, scanComplete: true, lastError: null,
      createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z",
      pausedAt: null, completedAt: null,
    });

    await service.tickCampaign();

    expect(repository.createBatch).toHaveBeenCalledWith(expect.objectContaining({ campaignId: "84" }));
  });

  it("waits for delayed retries before completing a campaign", async () => {
    const { repository, service } = setup();
    const campaign = {
      id: "85", targetId: "10", status: "running" as const, actor: "admin", reason: "mass",
      mode: "full_existing" as const, catalogRunId: "4", preflightWindow: 25, maxExports: 4,
      itemCount: 4, pendingCount: 0, retryCount: 1, runningCount: 0, completedCount: 3,
      failedCount: 0, acknowledgedFailedCount: 0, activePreflightCount: 0,
      scanBeforeInternalProductId: null, scanComplete: true, lastError: null,
      createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z",
      pausedAt: null, completedAt: null,
    };
    vi.mocked(repository.getRunningCampaign).mockResolvedValue(campaign);
    vi.mocked(repository.listExportCandidates).mockResolvedValue([]);

    await service.tickCampaign();

    expect(repository.setCampaignStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });
});
