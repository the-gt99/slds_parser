import { describe, expect, it, vi } from "vitest";
import { RetryableError } from "../../src/core/errors/index.js";
import { ShihuoProductClient } from "../../src/shihuo/product-clients.js";

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
});
