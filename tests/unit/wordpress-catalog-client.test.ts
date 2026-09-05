import { describe, expect, it, vi } from "vitest";

import { WordPressCatalogClient } from "../../src/integrations/wordpress/index.js";

const config = {
  baseUrl: "https://shop.example",
  authToken: "token",
  timeoutMs: 5_000,
  jobTimeoutMs: 10_000,
  pollIntervalMs: 100,
};

describe("WordPressCatalogClient.readProduct", () => {
  it("reads the current snapshot for the exact product ID", async () => {
    let requestBody: string | undefined;
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body);
      return new Response(JSON.stringify({
      ok: true,
      items: [{ target_id: 42, identity: { external_key: "goat:7" }, snapshot: { product: { id: 42 } } }],
      next_cursor: 42,
      has_more: true,
      }), { status: 200 });
    });
    const client = new WordPressCatalogClient(config, request as typeof fetch);

    await expect(client.readProduct("42")).resolves.toEqual({
      targetId: "42",
      identity: { external_key: "goat:7" },
      snapshot: { product: { id: 42 } },
    });
    const body = JSON.parse(requestBody!);
    expect(body).toEqual({ cursor: 41, limit: 1 });
  });

  it("does not accept the next catalog product as the requested product", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      items: [{ target_id: 43, identity: {}, snapshot: { product: { id: 43 } } }],
      next_cursor: 43,
      has_more: true,
    }), { status: 200 }));
    const client = new WordPressCatalogClient(config, request as typeof fetch);

    await expect(client.readProduct("42")).resolves.toBeNull();
  });
});
