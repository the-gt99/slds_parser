import type { TextTranslationProvider } from "../../processing/index.js";
import { IntegrationContractError, PermanentError, RetryableError } from "../../core/errors/index.js";

export interface LegacyGoogleTranslationProviderOptions {
  readonly timeoutMs: number;
  readonly attempts: number;
  readonly retryDelayMs: number;
}

const DT_PARAMETERS = ["t", "bd", "at", "ex", "ld", "md", "qca", "rw", "rm", "ss"] as const;

function token(text: string): string {
  let value = 406398;
  for (const byte of Buffer.from(text, "utf8")) {
    value += byte;
    value = shift(value, "+-a^+6");
  }
  value = shift(value, "+-3^+b+-f");
  value ^= 2087938574;
  value >>>= 0;
  value %= 1_000_000;
  return `${value}.${value ^ 406398}`;
}

function shift(input: number, pattern: string): number {
  let value = input;
  for (let index = 0; index < pattern.length - 2; index += 3) {
    const character = pattern[index + 2]!;
    const amount = character >= "a" ? character.charCodeAt(0) - 87 : Number(character);
    const shifted = pattern[index + 1] === "+" ? value >>> amount : value << amount;
    value = pattern[index] === "+" ? (value + shifted) & 0xffff_ffff : value ^ shifted;
  }
  return value;
}

function translatedText(value: unknown): string {
  if (!Array.isArray(value) || !Array.isArray(value[0])) throw new IntegrationContractError("Google translation response has an invalid shape");
  return value[0].flatMap((row) => Array.isArray(row) && typeof row[0] === "string" ? [row[0]] : []).join("").trim();
}

export class LegacyGoogleTranslationProvider implements TextTranslationProvider {
  readonly code = "legacy-google-translate";
  readonly version = "1.0.0";

  constructor(
    private readonly options: LegacyGoogleTranslationProviderOptions,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Translation timeout must be a positive integer");
    if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) throw new Error("Translation attempts must be a positive integer");
    if (!Number.isSafeInteger(options.retryDelayMs) || options.retryDelayMs < 0) throw new Error("Translation retry delay must be a non-negative integer");
  }

  async translate(text: string, sourceLocale: string, targetLocale: string): Promise<string> {
    if (sourceLocale === targetLocale) return text;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.attempts; attempt++) {
      try {
        return await this.translateOnce(text, sourceLocale, targetLocale);
      } catch (error) {
        lastError = error;
        if (error instanceof PermanentError || error instanceof IntegrationContractError) throw error;
        if (attempt < this.options.attempts && this.options.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs));
        }
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new RetryableError("Google translation request failed", { code: "TRANSLATION_REQUEST" });
  }

  async translateOnce(text: string, sourceLocale: string, targetLocale: string): Promise<string> {
    const url = new URL("https://translate.google.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("hl", "en");
    for (const value of DT_PARAMETERS) url.searchParams.append("dt", value);
    url.searchParams.set("sl", sourceLocale);
    url.searchParams.set("tl", targetLocale);
    url.searchParams.set("q", text);
    url.searchParams.set("ie", "UTF-8");
    url.searchParams.set("oe", "UTF-8");
    url.searchParams.set("multires", "1");
    url.searchParams.set("otf", "0");
    url.searchParams.set("pc", "1");
    url.searchParams.set("trs", "1");
    url.searchParams.set("ssel", "0");
    url.searchParams.set("tsel", "0");
    url.searchParams.set("kc", "1");
    url.searchParams.set("tk", token(text));

    let response: Response;
    try {
      response = await this.request(url, { signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch (cause) {
      throw new RetryableError("Google translation transport failed", { code: "TRANSLATION_REQUEST", cause });
    }
    if (response.status === 413) throw new PermanentError("Google translation text is too large", { code: "TRANSLATION_TOO_LARGE" });
    if (response.status === 429 || response.status === 503 || response.status >= 500) {
      throw new RetryableError(`Google translation failed with HTTP ${response.status}`, { code: "TRANSLATION_REQUEST" });
    }
    if (!response.ok) throw new PermanentError(`Google translation failed with HTTP ${response.status}`, { code: "TRANSLATION_REQUEST" });
    const raw = (await response.text()).replace(/,+/gu, ",").replace(/\[,/gu, "[").replaceAll("\u00a0", " ");
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch (cause) {
      throw new IntegrationContractError("Google translation response is not valid JSON", { cause });
    }
    const result = translatedText(decoded);
    if (result === "") throw new IntegrationContractError("Google translation response is empty");
    return result;
  }
}
