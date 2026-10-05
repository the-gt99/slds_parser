import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterTranslationProvider } from "../../src/infrastructure/translation/index.js";
import { IntegrationContractError, PermanentError } from "../../src/core/errors/index.js";

const options = { apiKey: "test-secret", model: "deepseek/deepseek-v3.2", timeoutMs: 1000, attempts: 2, retryDelayMs: 0, minBalanceUsd: 0 };
const success = () => new Response(JSON.stringify({ id: "request-1", choices: [{ finish_reason: "stop", message: { content: "Кожаный верх" } }], usage: { prompt_tokens: 70, completion_tokens: 5, cost: 0.00002 } }));

describe("OpenRouter translation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes configured requests through a dedicated proxy without sending its credentials to the API", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const request = vi.fn().mockResolvedValue(success());
    const provider = new OpenRouterTranslationProvider({ ...options, proxyUrl: "http://user:proxy-secret@localhost:8080" }, request);
    await provider.translate("Leather", "en", "ru");
    const init = request.mock.calls[0]![1];
    expect(init.dispatcher).toBeDefined();
    expect(JSON.stringify(init.headers)).not.toContain("proxy-secret");
    expect(JSON.stringify(init.body)).not.toContain("proxy-secret");
    await init.dispatcher.close();
    expect(() => new OpenRouterTranslationProvider({ ...options, proxyUrl: "invalid-secret" })).toThrow("proxy URL is invalid");
  });

  it("uses one explicit model, accounts for usage and keeps credentials out of logs", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const request = vi.fn().mockResolvedValue(success());
    const provider = new OpenRouterTranslationProvider(options, request);
    await expect(provider.translate("Leather upper", "en", "ru")).resolves.toBe("Кожаный верх");
    const body = JSON.parse(String(request.mock.calls[0]![1].body));
    expect(body.model).toBe(options.model);
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body.messages[1]).toEqual({ role: "user", content: "Leather upper" });
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ inputTokens: 70, outputTokens: 5, costUsd: 0.00002 });
    expect(JSON.stringify(log.mock.calls)).not.toContain(options.apiKey);
    expect(provider.version).not.toBe(new OpenRouterTranslationProvider({ ...options, model: "deepseek/deepseek-chat-v3.1" }).version);
  });

  it("retries transient failures with the same provider", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const request = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(success());
    await expect(new OpenRouterTranslationProvider(options, request).translate("Leather upper", "en", "ru")).resolves.toBe("Кожаный верх");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry exhausted credit", async () => {
    const request = vi.fn().mockResolvedValue(new Response("", { status: 402 }));
    await expect(new OpenRouterTranslationProvider(options, request).translate("Leather", "en", "ru")).rejects.toBeInstanceOf(PermanentError);
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps a bounded OpenRouter error reason for permanent request failures", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "provider_rejected", message: `Invalid request ${"x".repeat(500)}` },
    }), { status: 400 }));

    const error = await new OpenRouterTranslationProvider(options, request)
      .translate("Leather", "en", "ru").catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: "TRANSLATION_REQUEST",
      message: expect.stringMatching(/^OpenRouter translation HTTP 400 \(provider_rejected: Invalid request x+\)$/u),
    });
    expect((error as Error).message).not.toContain("x".repeat(301));
    expect(request).toHaveBeenCalledOnce();
  });

  it("stops before translation when the account balance is below the configured reserve", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 7.01 } })));
    const provider = new OpenRouterTranslationProvider({ ...options, minBalanceUsd: 3 }, request);
    await expect(provider.translate("Leather", "en", "ru")).rejects.toThrow("balance reserve reached");
    expect(request).toHaveBeenCalledOnce();
  });

  it("checks both account credit and the API key limit before calling the model", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { total_credits: 25, total_usage: 1 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { limit_remaining: 4.25 } })))
      .mockResolvedValueOnce(success());
    const provider = new OpenRouterTranslationProvider({ ...options, minBalanceUsd: 3 }, request);
    await expect(provider.translate("Leather upper", "en", "ru")).resolves.toBe("Кожаный верх");
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter.ai/api/v1/credits",
      "https://openrouter.ai/api/v1/key",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
  });

  it("shares only overlapping balance checks, without caching a passed reserve check", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let creditsCalls = 0;
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/credits")) {
        creditsCalls++;
        if (creditsCalls === 1) await pending;
        return new Response(JSON.stringify({ data: { total_credits: 25, total_usage: 1 } }));
      }
      if (String(url).endsWith("/key")) return new Response(JSON.stringify({ data: { limit_remaining: 4.25 } }));
      return success();
    });
    const provider = new OpenRouterTranslationProvider({ ...options, minBalanceUsd: 3 }, request);
    const first = provider.translate("Leather", "en", "ru");
    const second = provider.translate("Mesh", "en", "ru");
    expect(creditsCalls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(4);
    await provider.translate("Foam", "en", "ru");
    expect(creditsCalls).toBe(2);
    expect(request).toHaveBeenCalledTimes(7);
  });

  it.each(["length", "content_filter", null])("rejects unfinished output (%s)", async (reason) => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: reason, message: { content: "Кожаный" } }] })));
    await expect(new OpenRouterTranslationProvider(options, request).translate("Leather upper", "en", "ru")).rejects.toBeInstanceOf(IntegrationContractError);
    expect(request).toHaveBeenCalledOnce();
  });
});
