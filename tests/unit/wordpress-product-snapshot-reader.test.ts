import { describe, expect, it, vi } from "vitest";

import { IntegrationContractError, RetryableError } from "../../src/core/errors/index.js";
import { WordPressProductSnapshotReader } from "../../src/integrations/index.js";

const config = {
  baseUrl: "https://shop.example",
  authToken: "token",
  timeoutMs: 5_000,
  jobTimeoutMs: 10_000,
  pollIntervalMs: 100,
};

describe("WordPressProductSnapshotReader", () => {
  it("reads a complete batch and preserves missing products", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      items: [
        { source_external_id: "100", found: true, target_id: 321, snapshot: { product: { target_id: 321, taxonomies: {}, variations: [] } } },
        { source_external_id: "101", found: false, error_code: "target_not_found" },
      ],
    }), { status: 200 }));
    const reader = new WordPressProductSnapshotReader(config, fetchMock);

    await expect(reader.read("GOAT", ["100", "101"])).resolves.toEqual([
      { sourceExternalId: "100", found: true, externalId: "321", snapshot: { product: { target_id: 321, taxonomies: {}, variations: [] } } },
      { sourceExternalId: "101", found: false, errorCode: "target_not_found" },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slds_target_import_api=product-snapshots");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ source_code: "goat", source_external_ids: ["100", "101"] });
  });

  it("rejects a partial response instead of silently losing a requested product", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      items: [{ source_external_id: "100", found: false, error_code: "target_not_found" }],
    }), { status: 200 }));
    const reader = new WordPressProductSnapshotReader(config, fetchMock);

    await expect(reader.read("goat", ["100", "101"])).rejects.toBeInstanceOf(IntegrationContractError);
  });

  it("classifies an unavailable target as retryable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html>unavailable</html>", { status: 503 }));
    const reader = new WordPressProductSnapshotReader(config, fetchMock);

    await expect(reader.read("goat", ["100"])).rejects.toBeInstanceOf(RetryableError);
  });
});
