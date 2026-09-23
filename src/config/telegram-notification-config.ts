export interface TelegramNotificationEnvironment {
  readonly PARSER_TELEGRAM_BOT_TOKEN?: string;
  readonly PARSER_TELEGRAM_CHAT_ID?: string;
}

export interface TelegramNotificationConfig {
  readonly botToken: string;
  readonly chatId: string;
}

export function loadTelegramNotificationConfig(
  environment: TelegramNotificationEnvironment = process.env,
): TelegramNotificationConfig | null {
  const botToken = environment.PARSER_TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = environment.PARSER_TELEGRAM_CHAT_ID?.trim() ?? "";
  if (botToken === "" && chatId === "") return null;
  if (botToken === "" || chatId === "") {
    throw new Error("PARSER_TELEGRAM_BOT_TOKEN and PARSER_TELEGRAM_CHAT_ID must be configured together");
  }
  if (!/^-?\d+$/u.test(chatId)) throw new Error("PARSER_TELEGRAM_CHAT_ID must be an integer");
  return { botToken, chatId };
}
