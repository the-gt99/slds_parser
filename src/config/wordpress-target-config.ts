export interface WordPressTargetEnvironment {
  readonly PARSER_WORDPRESS_BASE_URL?: string;
  readonly PARSER_WORDPRESS_AUTH_TOKEN?: string;
  readonly PARSER_WORDPRESS_TIMEOUT_MS?: string;
}

export interface WordPressTargetConfig {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly timeoutMs: number;
}

export function loadWordPressTargetConfig(
  environment: WordPressTargetEnvironment = process.env,
): WordPressTargetConfig | null {
  const baseUrl = environment.PARSER_WORDPRESS_BASE_URL?.trim() ?? "";
  const authToken = environment.PARSER_WORDPRESS_AUTH_TOKEN?.trim() ?? "";
  if (baseUrl === "" && authToken === "") return null;
  if (baseUrl === "" || authToken === "") {
    throw new Error("PARSER_WORDPRESS_BASE_URL and PARSER_WORDPRESS_AUTH_TOKEN must be configured together");
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("PARSER_WORDPRESS_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("PARSER_WORDPRESS_BASE_URL must use HTTP or HTTPS");
  }

  const timeoutValue = environment.PARSER_WORDPRESS_TIMEOUT_MS?.trim() || "30000";
  const timeoutMs = Number(timeoutValue);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("PARSER_WORDPRESS_TIMEOUT_MS must be an integer from 1000 to 120000");
  }
  return { baseUrl: baseUrl.replace(/\/+$/u, ""), authToken, timeoutMs };
}
