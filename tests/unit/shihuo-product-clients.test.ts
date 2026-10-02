import { describe, expect, it, vi } from "vitest";
import { RetryableError } from "../../src/core/errors/index.js";
import { ShihuoProductClient, ShihuoSearchClient } from "../../src/shihuo/product-clients.js";
import type { ShihuoGuestProfile } from "../../src/shihuo/types.js";

const profile: ShihuoGuestProfile = { platform: "android", "app-v": "1", sk: "sk", luid: "luid", osv: "14", "user-agent": "test" };
const signer = { sign: vi.fn().mockResolvedValue({}), close: vi.fn() };

describe("Shihuo product clients", () => {
  it("classifies a product-card transport failure as retryable", async () => {
    const cause = Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" });
    const client = new ShihuoProductClient(vi.fn().mockRejectedValue(cause));

    await expect(client.fetch("10", "20")).rejects.toMatchObject({
      name: "RetryableError",
      code: "SHIHUO_PRODUCT_CARD_REQUEST_FAILED",
      cause,
    } satisfies Partial<RetryableError>);
  });

  it("classifies an application-level search failure as retryable", async () => {
    const client = new ShihuoSearchClient(signer, vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 90000,
      msg: "temporary upstream failure",
    }), { status: 200 })));

    await expect(client.searchAll(profile, "DO5870 001")).rejects.toMatchObject({
      name: "RetryableError",
      code: "SHIHUO_SEARCH_RESPONSE_FAILED",
      message: "Shihuo search returned API status 90000",
    } satisfies Partial<RetryableError>);
  });
});
