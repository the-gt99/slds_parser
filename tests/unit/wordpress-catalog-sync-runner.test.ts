import { describe, expect, it, vi } from "vitest";

import { WordPressCatalogSyncRunner } from "../../src/application/index.js";
import { parseSyncWordPressCatalogPayload } from "../../src/application/job-payloads.js";

describe("WordPressCatalogSyncRunner", () => {
  it("enrolls an exported product from its live identity without advancing the catalog", async () => {
    const repository = {
      getRun: vi.fn().mockResolvedValue({ id: "7", status: "completed", catalogComplete: true, catalogCursor: "500" }),
      listInventoryCandidates: vi.fn().mockResolvedValue([{ id: "8", wordpressProductId: "101", sourceCode: "goat", sourceExternalId: "42" }]),
      savePage: vi.fn(), enqueueInventoryReconciliation: vi.fn(),
    };
    const client = { readProduct: vi.fn().mockResolvedValue({ targetId: "101", identity: { source_code: "goat", source_external_id: "42" }, snapshot: { product: { target_id: 101 } } }) };
    const runner = new WordPressCatalogSyncRunner(repository as never, client as never);
    await expect(runner.sync(parseSyncWordPressCatalogPayload({ runId: "7", cursor: "0", mode: "inventory" }))).resolves.toEqual({ status: "completed" });
    expect(repository.savePage).toHaveBeenCalledWith(expect.objectContaining({ inventoryOnly: true, expectedCursor: "500", nextCursor: "500" }));
    expect(repository.enqueueInventoryReconciliation).not.toHaveBeenCalled();
  });

  it("does not enroll a product whose current identity differs from the export link", async () => {
    const repository = {
      getRun: vi.fn().mockResolvedValue({ id: "7", status: "completed", catalogComplete: true, catalogCursor: "500" }),
      listInventoryCandidates: vi.fn().mockResolvedValue([{ id: "8", wordpressProductId: "101", sourceCode: "goat", sourceExternalId: "42" }]),
      savePage: vi.fn(),
    };
    const client = { readProduct: vi.fn().mockResolvedValue({ targetId: "101", identity: { source_code: "goat", source_external_id: "99", legacy_goat_id: "42" }, snapshot: {} }) };
    const runner = new WordPressCatalogSyncRunner(repository as never, client as never);
    await expect(runner.sync({ runId: "7", cursor: "0", mode: "inventory" })).rejects.toThrow("identity mismatch");
    expect(repository.savePage).not.toHaveBeenCalled();
  });

  it("validates and persists an ordered catalog page", async () => {
    const repository = {
      getRun: vi.fn().mockResolvedValue({ id: "7", status: "running", catalogCursor: "100" }),
      savePage: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      readPage: vi.fn().mockResolvedValue({
        items: [
          { targetId: "101", identity: { legacy_goat_id: "500" }, snapshot: { product: { target_id: 101 } } },
          { targetId: "105", identity: {}, snapshot: { product: { target_id: 105 } } },
        ],
        nextCursor: "105",
        hasMore: true,
      }),
    };
    const runner = new WordPressCatalogSyncRunner(repository as never, client as never, 500);
    await expect(runner.sync({ runId: "7", cursor: "100" })).resolves.toEqual({ status: "completed" });
    expect(client.readPage).toHaveBeenCalledWith("100", 500);
    expect(repository.savePage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "7", expectedCursor: "100", nextCursor: "105", hasMore: true,
      items: [
        expect.objectContaining({ wordpressProductId: "101", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
        expect.objectContaining({ wordpressProductId: "105", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      ],
    }));
  });

  it("skips a page already committed before a worker retry", async () => {
    const repository = { getRun: vi.fn().mockResolvedValue({ id: "7", status: "running", catalogCursor: "200" }) };
    const client = { readPage: vi.fn() };
    const runner = new WordPressCatalogSyncRunner(repository as never, client as never);
    await expect(runner.sync({ runId: "7", cursor: "100" })).resolves.toEqual({ status: "skipped" });
    expect(client.readPage).not.toHaveBeenCalled();
  });

  it("rejects a page with duplicate or unordered IDs", async () => {
    const repository = {
      getRun: vi.fn().mockResolvedValue({ id: "7", status: "running", catalogCursor: "100" }),
      savePage: vi.fn(),
    };
    const client = {
      readPage: vi.fn().mockResolvedValue({
        items: [
          { targetId: "102", identity: {}, snapshot: {} },
          { targetId: "101", identity: {}, snapshot: {} },
        ],
        nextCursor: "101",
        hasMore: false,
      }),
    };
    const runner = new WordPressCatalogSyncRunner(repository as never, client as never);
    await expect(runner.sync({ runId: "7", cursor: "100" })).rejects.toThrow("not strictly ordered");
    expect(repository.savePage).not.toHaveBeenCalled();
  });
});
