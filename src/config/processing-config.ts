import { PermanentError } from "../core/errors/index.js";

export interface ProcessingEnvironment {
  readonly PARSER_IMAGE_STORAGE?: string;
  readonly PARSER_IMAGE_BASE_DIR?: string;
  readonly PARSER_PUBLIC_BASE_URL?: string;
  readonly PARSER_PUBLIC_PATH_PREFIX?: string;
  readonly PARSER_S3_ENDPOINT?: string;
  readonly PARSER_S3_REGION?: string;
  readonly PARSER_S3_BUCKET?: string;
  readonly PARSER_S3_ACCESS_KEY_ID?: string;
  readonly PARSER_S3_SECRET_ACCESS_KEY?: string;
  readonly GOAT_IMAGE_DOWNLOAD_CONCURRENCY?: string;
  readonly PARSER_TRANSLATION_PROVIDER?: string;
  readonly PARSER_OPENROUTER_API_KEY?: string;
  readonly PARSER_OPENROUTER_MODEL?: string;
  readonly PARSER_DEEPL_API_KEY?: string;
  readonly PARSER_DEEPL_API_URL?: string;
  readonly PARSER_TRANSLATION_SOURCE?: string;
  readonly PARSER_TRANSLATION_TARGET?: string;
  readonly PARSER_TRANSLATION_TIMEOUT_MS?: string;
  readonly PARSER_TRANSLATION_ATTEMPTS?: string;
  readonly PARSER_TRANSLATION_RETRY_DELAY_MS?: string;
  readonly SHOE_HEIGHT_API_URL?: string;
  readonly SHOE_HEIGHT_API_TIMEOUT_MS?: string;
  readonly SHOE_HEIGHT_API_ATTEMPTS?: string;
  readonly SHOE_HEIGHT_API_RETRY_DELAY_MS?: string;
  readonly SHOE_HEIGHT_SOURCE_IMAGE_POSITION?: string;
}

function integer(value: string | undefined, fallback: number, name: string, minimum: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new PermanentError(`${name} is invalid`, { code: "INVALID_PROCESSING_CONFIG" });
  return parsed;
}

function locale(value: string | undefined, fallback: string, name: string): string {
  const result = value?.trim() || fallback;
  if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(result)) throw new PermanentError(`${name} is invalid`, { code: "INVALID_PROCESSING_CONFIG" });
  return result;
}

function translationProvider(value: string | undefined): "google" | "deepl" | "openrouter" {
  const result = value?.trim().toLowerCase() || "google";
  if (result !== "google" && result !== "deepl" && result !== "openrouter") {
    throw new PermanentError("PARSER_TRANSLATION_PROVIDER must be google, deepl or openrouter", { code: "INVALID_PROCESSING_CONFIG" });
  }
  return result;
}

function httpsUrl(value: string | undefined, fallback: string, name: string): string {
  const result = value?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch (cause) {
    throw new PermanentError(`${name} is invalid`, { code: "INVALID_PROCESSING_CONFIG", cause });
  }
  if (parsed.protocol !== "https:") {
    throw new PermanentError(`${name} must use HTTPS`, { code: "INVALID_PROCESSING_CONFIG" });
  }
  return result;
}

function imageStorage(value: string | undefined): "local" | "s3" {
  const result = value?.trim().toLowerCase() || "local";
  if (result !== "local" && result !== "s3") {
    throw new PermanentError("PARSER_IMAGE_STORAGE must be local or s3", { code: "INVALID_PROCESSING_CONFIG" });
  }
  return result;
}

function required(value: string | undefined, name: string): string {
  const result = value?.trim() ?? "";
  if (result === "") throw new PermanentError(`${name} is required`, { code: "INVALID_PROCESSING_CONFIG" });
  return result;
}

export function loadProcessingConfig(environment: ProcessingEnvironment = process.env) {
  const publicBaseUrl = environment.PARSER_PUBLIC_BASE_URL?.trim() ?? "";
  if (publicBaseUrl === "") throw new PermanentError("PARSER_PUBLIC_BASE_URL is required for image publication", { code: "INVALID_PROCESSING_CONFIG" });
  let parsedPublicUrl: URL;
  try {
    parsedPublicUrl = new URL(publicBaseUrl);
  } catch (cause) {
    throw new PermanentError("PARSER_PUBLIC_BASE_URL is invalid", { code: "INVALID_PROCESSING_CONFIG", cause });
  }
  if (parsedPublicUrl.protocol !== "http:" && parsedPublicUrl.protocol !== "https:") {
    throw new PermanentError("PARSER_PUBLIC_BASE_URL must use HTTP or HTTPS", { code: "INVALID_PROCESSING_CONFIG" });
  }
  const shoeHeightApiUrl = environment.SHOE_HEIGHT_API_URL?.trim() ?? "";
  if (shoeHeightApiUrl !== "") {
    let parsedShoeHeightUrl: URL;
    try {
      parsedShoeHeightUrl = new URL(shoeHeightApiUrl);
    } catch (cause) {
      throw new PermanentError("SHOE_HEIGHT_API_URL is invalid", { code: "INVALID_PROCESSING_CONFIG", cause });
    }
    if (parsedShoeHeightUrl.protocol !== "http:" && parsedShoeHeightUrl.protocol !== "https:") {
      throw new PermanentError("SHOE_HEIGHT_API_URL must use HTTP or HTTPS", { code: "INVALID_PROCESSING_CONFIG" });
    }
  }
  const selectedTranslationProvider = translationProvider(environment.PARSER_TRANSLATION_PROVIDER);
  const selectedImageStorage = imageStorage(environment.PARSER_IMAGE_STORAGE);
  const imageStorageConfig = selectedImageStorage === "s3"
    ? {
        type: "s3" as const,
        endpoint: httpsUrl(environment.PARSER_S3_ENDPOINT, "https://storage.yandexcloud.net", "PARSER_S3_ENDPOINT"),
        region: environment.PARSER_S3_REGION?.trim() || "ru-central1",
        bucket: required(environment.PARSER_S3_BUCKET, "PARSER_S3_BUCKET"),
        accessKeyId: required(environment.PARSER_S3_ACCESS_KEY_ID, "PARSER_S3_ACCESS_KEY_ID"),
        secretAccessKey: required(environment.PARSER_S3_SECRET_ACCESS_KEY, "PARSER_S3_SECRET_ACCESS_KEY"),
      }
    : { type: "local" as const };
  const translationApiKey = environment.PARSER_DEEPL_API_KEY?.trim() ?? "";
  const openRouterApiKey = environment.PARSER_OPENROUTER_API_KEY?.trim() ?? "";
  if (selectedTranslationProvider === "openrouter" && openRouterApiKey === "") {
    throw new PermanentError("PARSER_OPENROUTER_API_KEY is required", { code: "INVALID_PROCESSING_CONFIG" });
  }
  if (selectedTranslationProvider === "deepl" && translationApiKey === "") {
    throw new PermanentError("PARSER_DEEPL_API_KEY is required for the DeepL translation provider", { code: "INVALID_PROCESSING_CONFIG" });
  }
  const translationOptions = {
    sourceLocale: locale(environment.PARSER_TRANSLATION_SOURCE, "en", "PARSER_TRANSLATION_SOURCE"),
    targetLocale: locale(environment.PARSER_TRANSLATION_TARGET, "ru", "PARSER_TRANSLATION_TARGET"),
    timeoutMs: integer(environment.PARSER_TRANSLATION_TIMEOUT_MS, selectedTranslationProvider === "openrouter" ? 60_000 : 8_000, "PARSER_TRANSLATION_TIMEOUT_MS", 1),
    attempts: integer(environment.PARSER_TRANSLATION_ATTEMPTS, 2, "PARSER_TRANSLATION_ATTEMPTS", 1),
    retryDelayMs: integer(environment.PARSER_TRANSLATION_RETRY_DELAY_MS, 400, "PARSER_TRANSLATION_RETRY_DELAY_MS", 0),
  } as const;
  return {
    image: {
      baseDirectory: environment.PARSER_IMAGE_BASE_DIR?.trim() || "runtime/images",
      publicBaseUrl,
      publicPathPrefix: environment.PARSER_PUBLIC_PATH_PREFIX?.trim() ?? "",
      webpQuality: 85,
      transportConcurrency: integer(environment.GOAT_IMAGE_DOWNLOAD_CONCURRENCY, 8, "GOAT_IMAGE_DOWNLOAD_CONCURRENCY", 1),
      operationConcurrency: 2,
      storage: imageStorageConfig,
    },
    translation: selectedTranslationProvider === "deepl"
      ? {
          ...translationOptions,
          provider: "deepl" as const,
          apiKey: translationApiKey,
          apiUrl: httpsUrl(environment.PARSER_DEEPL_API_URL, "https://api.deepl.com/v2/translate", "PARSER_DEEPL_API_URL"),
        }
      : selectedTranslationProvider === "openrouter"
        ? { ...translationOptions, provider: "openrouter" as const,
          apiKey: openRouterApiKey,
          model: environment.PARSER_OPENROUTER_MODEL?.trim() || "deepseek/deepseek-v3.2" }
        : { ...translationOptions, provider: "google" as const },
    shoeHeight: shoeHeightApiUrl === "" ? null : {
      apiUrl: shoeHeightApiUrl,
      timeoutMs: integer(environment.SHOE_HEIGHT_API_TIMEOUT_MS, 20_000, "SHOE_HEIGHT_API_TIMEOUT_MS", 1),
      attempts: integer(environment.SHOE_HEIGHT_API_ATTEMPTS, 2, "SHOE_HEIGHT_API_ATTEMPTS", 1),
      retryDelayMs: integer(environment.SHOE_HEIGHT_API_RETRY_DELAY_MS, 400, "SHOE_HEIGHT_API_RETRY_DELAY_MS", 0),
      sourceImagePosition: integer(environment.SHOE_HEIGHT_SOURCE_IMAGE_POSITION, 0, "SHOE_HEIGHT_SOURCE_IMAGE_POSITION", 0),
    },
  } as const;
}
