import { describe, expect, it, vi } from "vitest";
import { enqueueScheduledGoatDiscovery } from "../../src/services/source-discovery-schedule.js";
import type { JobRepository, SourceRepository } from "../../src/repositories/index.js";
describe("scheduled GOAT discovery", () => {
  it("enqueues only new collection with a stable active-job key", async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: "8", status: "pending" });
    const repositories = { sources: { listEnabled: vi.fn().mockResolvedValue([{ id: "1", code: "goat" }]) } as unknown as SourceRepository,
      jobs: { enqueue } as unknown as JobRepository };
    await enqueueScheduledGoatDiscovery(repositories);
    await enqueueScheduledGoatDiscovery(repositories);
    expect(enqueue).toHaveBeenCalledWith({ jobType: "discover_source", uniqueKey: "source:1:scheduled-discovery",
      payload: { sourceId: "1", runType: "full", coverage: "catalog", enqueueCollection: false, enqueueNewCollection: true } });
    expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[1]);
  });
  it("does not create or enable a missing source", async () => {
    const enqueue = vi.fn();
    await expect(enqueueScheduledGoatDiscovery({ sources: { listEnabled: vi.fn().mockResolvedValue([]) } as unknown as SourceRepository,
      jobs: { enqueue } as unknown as JobRepository })).rejects.toThrow("Enabled GOAT source");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
