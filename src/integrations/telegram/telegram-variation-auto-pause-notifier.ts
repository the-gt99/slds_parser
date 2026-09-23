import type { TelegramNotificationConfig } from "../../config/index.js";
import type { VariationAutoPauseNotification, VariationAutoPauseNotifier } from "../../services/wordpress-catalog-service.js";

type Fetch = typeof fetch;

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export class TelegramVariationAutoPauseNotifier implements VariationAutoPauseNotifier {
  constructor(
    private readonly config: TelegramNotificationConfig,
    private readonly request: Fetch = fetch,
  ) {}

  async notify(notification: VariationAutoPauseNotification): Promise<void> {
    const reason = oneLine(notification.error ?? "причина не указана");
    const text = `SLDS Parser: обновление цен и остатков остановлено | прогон #${notification.runId} | ошибок: ${notification.failedCount} | причина: ${reason}`;
    const response = await this.request(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.config.chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  }
}
