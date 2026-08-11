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
};

function setup() {
  const repository = {
    preparePreflightCandidates: vi.fn().mockResolvedValue([{ sourceProductId: "21", internalProductId: "31" }]),
    listExportCandidates: vi.fn().mockResolvedValue([candidate]),
    createBatch: vi.fn().mockResolvedValue({
      batchId: "51",
      items: [{ id: "61", sourceProductId: "21", internalProductId: "31" }],
      jobIds: ["71"],
    }),
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
      payload: { sourceProductId: "21", targetId: "10" },
      uniqueKey: "target-product:10:21:preflight",
    }]);
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
});
