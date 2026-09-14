import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterTranslationProvider } from "../../src/infrastructure/translation/index.js";
import { IntegrationContractError, PermanentError } from "../../src/core/errors/index.js";

const options = { apiKey: "test-secret", model: "deepseek/deepseek-v3.2", timeoutMs: 1000, attempts: 2, retryDelayMs: 0 };
const success = () => new Response(JSON.stringify({ id: "request-1", choices: [{ finish_reason: "stop", message: { content: "Кожаный верх" } }], usage: { prompt_tokens: 70, completion_tokens: 5, cost: 0.00002 } }));

describe("OpenRouter translation", () => {
  afterEach(() => vi.restoreAllMocks());

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

  it.each(["length", "content_filter", null])("rejects unfinished output (%s)", async (reason) => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: reason, message: { content: "Кожаный" } }] })));
    await expect(new OpenRouterTranslationProvider(options, request).translate("Leather upper", "en", "ru")).rejects.toBeInstanceOf(IntegrationContractError);
    expect(request).toHaveBeenCalledOnce();
  });
});
