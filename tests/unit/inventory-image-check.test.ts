import { describe, expect, it, vi } from "vitest";
import { WordPressVariationPatchRunner } from "../../src/application/wordpress-variation-patch-runner.js";

function fixture() {
  const candidate = { item: { id: "7", wordpressProductId: "100" }, target: { id: "3" }, sourceProduct: { id: "2" } };
  const repository = { listVariationCandidates: vi.fn(async () => [candidate]), saveInventoryDonorState: vi.fn() };
  const sourceRefresher = { refresh: vi.fn(async () => []) };
  const imageRefreshes = { enqueueDue: vi.fn() };
  const logError = vi.fn();
  const runner = Object.assign(Object.create(WordPressVariationPatchRunner.prototype), { repository, sourceRefresher,
    sources: { getById: vi.fn(async () => ({ id: "1", code: "goat" })) },
    sourceProducts: { getById: vi.fn(async () => ({ id: "2", sourceId: "1" })) },
    currentTime: () => 0, imageRefreshes, logError }) as WordPressVariationPatchRunner;
  return { runner, imageRefreshes, repository, sourceRefresher, logError };
}

describe("inventory image check scheduling", () => {
  it("queues a deferred image check after a successful GOAT refresh, including sold-out offers", async () => {
    const f = fixture();
    await expect(f.runner.collectGoat({ runId: "4", itemId: "7", wordpressProductId: "100" })).resolves.toEqual({ status: "completed" });
    expect(f.imageRefreshes.enqueueDue).toHaveBeenCalledWith({ sourceProductId: "2", targetId: "3", externalId: "100" });
    expect(f.repository.saveInventoryDonorState).toHaveBeenCalledWith(expect.objectContaining({ donorCode: "goat", variants: [] }));
    expect(f.repository.saveInventoryDonorState.mock.invocationCallOrder[0]).toBeLessThan(f.imageRefreshes.enqueueDue.mock.invocationCallOrder[0]!);
  });

  it("does not retry or fail price and stock updates because the image queue failed", async () => {
    const f = fixture(); f.imageRefreshes.enqueueDue.mockRejectedValue(new Error("Database busy"));
    await expect(f.runner.collectGoat({ runId: "4", itemId: "7", wordpressProductId: "100" })).resolves.toEqual({ status: "completed" });
    expect(f.repository.saveInventoryDonorState).toHaveBeenCalledOnce();
    expect(f.logError).toHaveBeenCalledWith(expect.stringContaining("Image check scheduling failed"));
  });
});
