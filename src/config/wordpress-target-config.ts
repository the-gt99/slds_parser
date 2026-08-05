export interface WordPressTargetEnvironment {
  readonly PARSER_WORDPRESS_BASE_URL?: string;
  readonly PARSER_WORDPRESS_AUTH_TOKEN?: string;
  readonly PARSER_WORDPRESS_TIMEOUT_MS?: string;
  readonly PARSER_WORDPRESS_JOB_TIMEOUT_MS?: string;
  readonly PARSER_WORDPRESS_POLL_INTERVAL_MS?: string;
}

export interface WordPressTargetConfig {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly timeoutMs: number;
  readonly jobTimeoutMs: number;
  readonly pollIntervalMs: number;
}

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
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

  const timeoutMs = integer(environment.PARSER_WORDPRESS_TIMEOUT_MS, 30_000, "PARSER_WORDPRESS_TIMEOUT_MS", 1_000, 120_000);
  const jobTimeoutMs = integer(environment.PARSER_WORDPRESS_JOB_TIMEOUT_MS, 900_000, "PARSER_WORDPRESS_JOB_TIMEOUT_MS", 10_000, 1_800_000);
  const pollIntervalMs = integer(environment.PARSER_WORDPRESS_POLL_INTERVAL_MS, 2_000, "PARSER_WORDPRESS_POLL_INTERVAL_MS", 100, 30_000);
  return { baseUrl: baseUrl.replace(/\/+$/u, ""), authToken, timeoutMs, jobTimeoutMs, pollIntervalMs };
}
