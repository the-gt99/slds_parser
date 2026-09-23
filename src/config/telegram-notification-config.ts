export interface TelegramNotificationEnvironment {
  readonly PARSER_TELEGRAM_BOT_TOKEN?: string;
  readonly PARSER_TELEGRAM_CHAT_ID?: string;
  readonly PARSER_TELEGRAM_PROXY_URL?: string;
}

export interface TelegramNotificationConfig {
  readonly botToken: string;
  readonly chatId: string;
  readonly proxyUrl?: string;
}

export function loadTelegramNotificationConfig(
  environment: TelegramNotificationEnvironment = process.env,
): TelegramNotificationConfig | null {
  const botToken = environment.PARSER_TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = environment.PARSER_TELEGRAM_CHAT_ID?.trim() ?? "";
  const proxyUrl = environment.PARSER_TELEGRAM_PROXY_URL?.trim() ?? "";
  if (botToken === "" && chatId === "") return null;
  if (botToken === "" || chatId === "") {
    throw new Error("PARSER_TELEGRAM_BOT_TOKEN and PARSER_TELEGRAM_CHAT_ID must be configured together");
  }
  if (!/^-?\d+$/u.test(chatId)) throw new Error("PARSER_TELEGRAM_CHAT_ID must be an integer");
  if (proxyUrl !== "") {
    let parsed: URL;
    try {
      parsed = new URL(proxyUrl);
    } catch {
      throw new Error("PARSER_TELEGRAM_PROXY_URL must be an absolute HTTP(S) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("PARSER_TELEGRAM_PROXY_URL must use HTTP or HTTPS");
    }
  }
  return { botToken, chatId, ...(proxyUrl === "" ? {} : { proxyUrl }) };
}
