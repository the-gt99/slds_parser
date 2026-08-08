import { PermanentError } from "../core/errors/index.js";

export interface ProcessingEnvironment {
  readonly PARSER_IMAGE_BASE_DIR?: string;
  readonly PARSER_PUBLIC_BASE_URL?: string;
  readonly PARSER_PUBLIC_PATH_PREFIX?: string;
  readonly GOAT_IMAGE_DOWNLOAD_CONCURRENCY?: string;
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
  return {
    image: {
      baseDirectory: environment.PARSER_IMAGE_BASE_DIR?.trim() || "runtime/images",
      publicBaseUrl,
      publicPathPrefix: environment.PARSER_PUBLIC_PATH_PREFIX?.trim() ?? "",
      webpQuality: 85,
      concurrency: integer(environment.GOAT_IMAGE_DOWNLOAD_CONCURRENCY, 2, "GOAT_IMAGE_DOWNLOAD_CONCURRENCY", 1),
    },
    translation: {
      sourceLocale: locale(environment.PARSER_TRANSLATION_SOURCE, "en", "PARSER_TRANSLATION_SOURCE"),
      targetLocale: locale(environment.PARSER_TRANSLATION_TARGET, "ru", "PARSER_TRANSLATION_TARGET"),
      timeoutMs: integer(environment.PARSER_TRANSLATION_TIMEOUT_MS, 8_000, "PARSER_TRANSLATION_TIMEOUT_MS", 1),
      attempts: integer(environment.PARSER_TRANSLATION_ATTEMPTS, 2, "PARSER_TRANSLATION_ATTEMPTS", 1),
      retryDelayMs: integer(environment.PARSER_TRANSLATION_RETRY_DELAY_MS, 400, "PARSER_TRANSLATION_RETRY_DELAY_MS", 0),
    },
    shoeHeight: shoeHeightApiUrl === "" ? null : {
      apiUrl: shoeHeightApiUrl,
      timeoutMs: integer(environment.SHOE_HEIGHT_API_TIMEOUT_MS, 20_000, "SHOE_HEIGHT_API_TIMEOUT_MS", 1),
      attempts: integer(environment.SHOE_HEIGHT_API_ATTEMPTS, 2, "SHOE_HEIGHT_API_ATTEMPTS", 1),
      retryDelayMs: integer(environment.SHOE_HEIGHT_API_RETRY_DELAY_MS, 400, "SHOE_HEIGHT_API_RETRY_DELAY_MS", 0),
      sourceImagePosition: integer(environment.SHOE_HEIGHT_SOURCE_IMAGE_POSITION, 0, "SHOE_HEIGHT_SOURCE_IMAGE_POSITION", 0),
    },
  } as const;
}
