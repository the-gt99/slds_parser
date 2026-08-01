import { describe, expect, it, vi } from "vitest";

import { LegacyGoogleTranslationProvider } from "../../src/infrastructure/translation/index.js";

describe("legacy Google translation provider", () => {
  it("ports the request contract used by the previous parser", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify([[['Привет', 'Hello']]]), { status: 200 }));
    const provider = new LegacyGoogleTranslationProvider({ timeoutMs: 1_000, attempts: 1, retryDelayMs: 0 }, request);

    await expect(provider.translate("Hello", "en", "ru")).resolves.toBe("Привет");
    const url = request.mock.calls[0]?.[0] as URL;
    expect(url.origin + url.pathname).toBe("https://translate.google.com/translate_a/single");
    expect(url.searchParams.get("client")).toBe("gtx");
    expect(url.searchParams.get("sl")).toBe("en");
    expect(url.searchParams.get("tl")).toBe("ru");
    expect(url.searchParams.get("q")).toBe("Hello");
    expect(url.searchParams.get("tk")).toMatch(/^\d+\.\d+$/u);
  });

  it("retries the same statuses as the previous provider", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([[['Привет', 'Hello']]]), { status: 200 }));
    const provider = new LegacyGoogleTranslationProvider({ timeoutMs: 1_000, attempts: 2, retryDelayMs: 0 }, request);

    await expect(provider.translate("Hello", "en", "ru")).resolves.toBe("Привет");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
