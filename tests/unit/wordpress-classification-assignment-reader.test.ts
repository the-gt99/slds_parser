import { describe, expect, it, vi } from "vitest";

import { WordPressClassificationAssignmentReader } from "../../src/integrations/index.js";

const config = {
  baseUrl: "https://shop.example",
  authToken: "secret",
  timeoutMs: 5_000,
  jobTimeoutMs: 10_000,
  pollIntervalMs: 100,
};

describe("WordPressClassificationAssignmentReader", () => {
  it("reads one minimal assignment page", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      items: [{
        source_external_id: "1241656",
        target_id: 772888,
        taxonomies: { pa_model: [{ term_id: 16096, name: "Nike Dunk", slug: "nike-dunk" }] },
      }],
      next_cursor: 772888,
      has_more: true,
    }), { status: 200 }));
    const reader = new WordPressClassificationAssignmentReader(config, request);
    await expect(reader.readPage({
      sourceCode: "goat",
      cursor: "0",
      limit: 2000,
      taxonomies: ["pa_brand", "pa_model", "product_cat"],
    })).resolves.toEqual({
      items: [{
        sourceExternalId: "1241656",
        targetExternalId: "772888",
        taxonomies: { pa_model: [{ term_id: 16096, name: "Nike Dunk", slug: "nike-dunk" }] },
      }],
      nextCursor: "772888",
      hasMore: true,
    });
    expect(String(request.mock.calls[0]?.[0])).toContain("slds_target_import_api=classification-assignments");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ cursor: "0", limit: 2000 });
  });

  it("rejects pagination that does not advance", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, items: [], next_cursor: 10, has_more: true,
    }), { status: 200 }));
    const reader = new WordPressClassificationAssignmentReader(config, request);
    await expect(reader.readPage({ sourceCode: "goat", cursor: "10", limit: 10, taxonomies: ["pa_model"] }))
      .rejects.toThrow("cursor did not advance");
  });
});
