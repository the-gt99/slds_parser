import { IntegrationContractError, PermanentError, RetryableError } from "../../core/errors/index.js";
import type { TextTranslationProvider } from "../../processing/index.js";

export interface DeepLTranslationProviderOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly attempts: number;
  readonly retryDelayMs: number;
}

function languageCode(locale: string, source: boolean): string {
  const normalized = locale.trim().replaceAll("_", "-").toUpperCase();
  return source ? normalized.split("-")[0]! : normalized;
}

function translatedText(value: unknown): string {
  if (typeof value !== "object" || value === null || !("translations" in value) || !Array.isArray(value.translations)) {
    throw new IntegrationContractError("DeepL translation response has an invalid shape");
  }
  const translation = value.translations[0];
  if (typeof translation !== "object" || translation === null || !("text" in translation) || typeof translation.text !== "string") {
    throw new IntegrationContractError("DeepL translation response has an invalid shape");
  }
  const result = translation.text
    .normalize("NFC")
    .replace(/[\p{Cf}\u00a0]+/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .trim();
  if (result === "") throw new IntegrationContractError("DeepL translation response is empty");
  return result;
}

export class DeepLTranslationProvider implements TextTranslationProvider {
  readonly code = "deepl";
  readonly version = "1.0.0";

  constructor(
    private readonly options: DeepLTranslationProviderOptions,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {
    if (options.apiKey.trim() === "") throw new Error("DeepL API key is required");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Translation timeout must be a positive integer");
    if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) throw new Error("Translation attempts must be a positive integer");
    if (!Number.isSafeInteger(options.retryDelayMs) || options.retryDelayMs < 0) throw new Error("Translation retry delay must be a non-negative integer");
  }

  async translate(text: string, sourceLocale: string, targetLocale: string): Promise<string> {
    if (sourceLocale.toLowerCase() === targetLocale.toLowerCase()) return text;
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
    throw new RetryableError("DeepL translation request failed", { code: "TRANSLATION_REQUEST" });
  }

  async translateOnce(text: string, sourceLocale: string, targetLocale: string): Promise<string> {
    let response: Response;
    try {
      response = await this.request("https://api.deepl.com/v2/translate", {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: [text],
          source_lang: languageCode(sourceLocale, true),
          target_lang: languageCode(targetLocale, false),
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      throw new RetryableError("DeepL translation transport failed", { code: "TRANSLATION_REQUEST", cause });
    }
    if (response.status === 413) throw new PermanentError("DeepL translation text is too large", { code: "TRANSLATION_TOO_LARGE" });
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableError(`DeepL translation failed with HTTP ${response.status}`, { code: "TRANSLATION_REQUEST" });
    }
    if (response.status === 456) throw new PermanentError("DeepL translation quota is exceeded", { code: "TRANSLATION_QUOTA" });
    if (!response.ok) throw new PermanentError(`DeepL translation failed with HTTP ${response.status}`, { code: "TRANSLATION_REQUEST" });
    let decoded: unknown;
    try {
      decoded = JSON.parse(await response.text()) as unknown;
    } catch (cause) {
      throw new IntegrationContractError("DeepL translation response is not valid JSON", { cause });
    }
    return translatedText(decoded);
  }
}
