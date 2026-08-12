import { describe, expect, it, vi } from "vitest";

import { TargetClassificationSyncRunner } from "../../src/application/index.js";

describe("TargetClassificationSyncRunner", () => {
  it("persists every page and its next cursor", async () => {
    const repository = {
      getRun: vi.fn().mockResolvedValue({ id: "7", sourceCode: "goat", status: "running", cursor: "100" }),
      savePage: vi.fn().mockResolvedValue(undefined),
      failRun: vi.fn(),
    };
    const reader = {
      readPage: vi.fn().mockResolvedValue({
        items: [{ sourceExternalId: "5", targetExternalId: "9", taxonomies: { pa_model: [] } }],
        nextCursor: "200",
        hasMore: true,
      }),
    };
    const runner = new TargetClassificationSyncRunner(repository as never, reader as never, 500);
    await expect(runner.sync({ runId: "7", cursor: "100" })).resolves.toEqual({ status: "completed" });
    expect(reader.readPage).toHaveBeenCalledWith({
      sourceCode: "goat", cursor: "100", limit: 500,
      taxonomies: ["pa_brand", "pa_model", "product_cat"],
    });
    expect(repository.savePage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "7", cursor: "100", nextCursor: "200", hasMore: true,
    }));
  });

  it("skips an already persisted page", async () => {
    const repository = { getRun: vi.fn().mockResolvedValue({ id: "7", sourceCode: "goat", status: "running", cursor: "200" }) };
    const reader = { readPage: vi.fn() };
    const runner = new TargetClassificationSyncRunner(repository as never, reader as never);
    await expect(runner.sync({ runId: "7", cursor: "100" })).resolves.toEqual({ status: "skipped" });
    expect(reader.readPage).not.toHaveBeenCalled();
  });
});
