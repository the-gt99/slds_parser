import { describe, expect, it, vi } from "vitest";

import { CachedTranslationProvider, DeepLTranslationProvider, LegacyGoogleTranslationProvider, type TranslationCacheRepository } from "../../src/infrastructure/translation/index.js";
import { PermanentError } from "../../src/core/errors/index.js";

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

  it("removes invisible formatting characters from translated text", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify([[['в \u200bпередней\u00a0части', 'in forefoot']]]), { status: 200 }));
    const provider = new LegacyGoogleTranslationProvider({ timeoutMs: 1_000, attempts: 1, retryDelayMs: 0 }, request);

    await expect(provider.translate("in forefoot", "en", "ru")).resolves.toBe("в передней части");
  });
});

describe("DeepL translation provider", () => {
  const options = { apiKey: "secret", timeoutMs: 1_000, attempts: 1, retryDelayMs: 0 };

  it("uses the paid DeepL API contract without exposing the key in the body", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      translations: [{ detected_source_language: "EN", text: "Привет" }],
    }), { status: 200 }));
    const provider = new DeepLTranslationProvider(options, request);

    await expect(provider.translate("Hello", "en", "ru")).resolves.toBe("Привет");
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepl.com/v2/translate");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "DeepL-Auth-Key secret", "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ text: ["Hello"], source_lang: "EN", target_lang: "RU" });
    expect(String(init.body)).not.toContain("secret");
  });

  it("retries transient DeepL failures", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ translations: [{ text: "Привет" }] }), { status: 200 }));
    const provider = new DeepLTranslationProvider({ ...options, attempts: 2 }, request);

    await expect(provider.translate("Hello", "en", "ru")).resolves.toBe("Привет");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry an exhausted DeepL quota", async () => {
    const request = vi.fn().mockResolvedValue(new Response("", { status: 456 }));
    const provider = new DeepLTranslationProvider({ ...options, attempts: 2 }, request);

    await expect(provider.translate("Hello", "en", "ru")).rejects.toBeInstanceOf(PermanentError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("normalizes invisible formatting characters", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      translations: [{ text: "в \u200bпередней\u00a0части" }],
    }), { status: 200 }));
    const provider = new DeepLTranslationProvider(options, request);

    await expect(provider.translate("in forefoot", "en", "ru")).resolves.toBe("в передней части");
  });
});

describe("cached translation provider", () => {
  it("persists successful translations and reuses them", async () => {
    const values = new Map<string, string>();
    const cache: TranslationCacheRepository = {
      find: vi.fn(async (key) => values.get(key.sourceHash) ?? null),
      save: vi.fn(async (key, translated) => { values.set(key.sourceHash, translated); return translated; }),
    };
    const translate = vi.fn(async () => "Привет");
    const provider = new CachedTranslationProvider({ code: "deepl", version: "1", translate }, cache);

    await expect(provider.translate("Hello", "en", "ru")).resolves.toBe("Привет");
    await expect(provider.translate("Hello", "en", "ru")).resolves.toBe("Привет");

    expect(translate).toHaveBeenCalledOnce();
    expect(cache.save).toHaveBeenCalledOnce();
    expect(cache.find).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent cache misses", async () => {
    let resolveTranslation!: (value: string) => void;
    const translate = vi.fn(() => new Promise<string>((resolve) => { resolveTranslation = resolve; }));
    const cache: TranslationCacheRepository = { find: vi.fn().mockResolvedValue(null), save: vi.fn(async (_key, value) => value) };
    const provider = new CachedTranslationProvider({ code: "deepl", version: "1", translate }, cache);

    const first = provider.translate("Hello", "en", "ru");
    const second = provider.translate("Hello", "en", "ru");
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    resolveTranslation("Привет");

    await expect(Promise.all([first, second])).resolves.toEqual(["Привет", "Привет"]);
    expect(cache.save).toHaveBeenCalledOnce();
  });
});
