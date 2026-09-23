import { describe, expect, it, vi } from "vitest";
import { TelegramVariationAutoPauseNotifier } from "../../src/integrations/index.js";

describe("TelegramVariationAutoPauseNotifier", () => {
  it("sends a single-line pause notification", async () => {
    const request = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const notifier = new TelegramVariationAutoPauseNotifier(
      { botToken: "token", chatId: "123" },
      request,
    );

    await notifier.notify({ runId: "4", failedCount: 2, error: "first\nsecond" });

    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as { chat_id: string; text: string };
    expect(body).toEqual({
      chat_id: "123",
      text: "SLDS Parser: обновление цен и остатков остановлено | прогон #4 | ошибок: 2 | причина: first second",
    });
  });

  it("rejects a failed Telegram response without exposing the token", async () => {
    const request = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    const notifier = new TelegramVariationAutoPauseNotifier({ botToken: "secret", chatId: "123" }, request);

    await expect(notifier.notify({ runId: "4", failedCount: 1, error: null }))
      .rejects.toThrow("Telegram sendMessage failed with HTTP 401");
  });

  it("passes the configured proxy dispatcher to Telegram requests", async () => {
    const request = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const notifier = new TelegramVariationAutoPauseNotifier(
      { botToken: "token", chatId: "123", proxyUrl: "http://proxy.example:8080" },
      request,
    );

    await notifier.notify({ runId: "4", failedCount: 1, error: "failed" });

    expect(request.mock.calls[0]?.[1]).toMatchObject({ dispatcher: expect.any(Object) });
  });
});
