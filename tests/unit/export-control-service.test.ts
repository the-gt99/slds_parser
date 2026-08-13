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
      preflightWindow: 25, maxExports: 100, itemCount: 3, pendingCount: 0, runningCount: 0,
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
});
