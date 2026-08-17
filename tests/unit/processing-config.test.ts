import { describe, expect, it } from "vitest";

import { loadProcessingConfig } from "../../src/config/index.js";
import { PermanentError } from "../../src/core/errors/index.js";

describe("processing config", () => {
  it("uses the confirmed legacy processing defaults", () => {
    expect(loadProcessingConfig({ PARSER_PUBLIC_BASE_URL: "https://parser.example/images" })).toEqual({
      image: { baseDirectory: "runtime/images", publicBaseUrl: "https://parser.example/images", publicPathPrefix: "", webpQuality: 85, transportConcurrency: 8, operationConcurrency: 2 },
      translation: { provider: "google", sourceLocale: "en", targetLocale: "ru", timeoutMs: 8_000, attempts: 2, retryDelayMs: 400 },
      shoeHeight: null,
    });
  });

  it("keeps operation concurrency stable when image transport concurrency changes", () => {
    const config = loadProcessingConfig({
      PARSER_PUBLIC_BASE_URL: "https://parser.example/images",
      GOAT_IMAGE_DOWNLOAD_CONCURRENCY: "12",
    });

    expect(config.image.transportConcurrency).toBe(12);
    expect(config.image.operationConcurrency).toBe(2);
  });

  it("loads the optional shoe height classifier contract", () => {
    expect(loadProcessingConfig({
      PARSER_PUBLIC_BASE_URL: "https://parser.example/images",
      SHOE_HEIGHT_API_URL: "http://classifier.example/predict",
    }).shoeHeight).toEqual({
      apiUrl: "http://classifier.example/predict",
      timeoutMs: 20_000,
      attempts: 2,
      retryDelayMs: 400,
      sourceImagePosition: 0,
    });
    expect(() => loadProcessingConfig({
      PARSER_PUBLIC_BASE_URL: "https://parser.example/images",
      SHOE_HEIGHT_API_URL: "file:///classifier",
    })).toThrow(PermanentError);
  });

  it("selects DeepL only with an explicit API key", () => {
    expect(loadProcessingConfig({
      PARSER_PUBLIC_BASE_URL: "https://parser.example/images",
      PARSER_TRANSLATION_PROVIDER: "deepl",
      PARSER_DEEPL_API_KEY: "secret",
    }).translation).toEqual({
      provider: "deepl",
      apiKey: "secret",
      apiUrl: "https://api.deepl.com/v2/translate",
      sourceLocale: "en",
      targetLocale: "ru",
      timeoutMs: 8_000,
      attempts: 2,
      retryDelayMs: 400,
    });
    expect(() => loadProcessingConfig({
      PARSER_PUBLIC_BASE_URL: "https://parser.example/images",
      PARSER_TRANSLATION_PROVIDER: "deepl",
    })).toThrow(PermanentError);
    expect(() => loadProcessingConfig({
      PARSER_PUBLIC_BASE_URL: "https://parser.example/images",
      PARSER_TRANSLATION_PROVIDER: "deepl",
      PARSER_DEEPL_API_KEY: "secret",
      PARSER_DEEPL_API_URL: "http://api.deepl.com/v2/translate",
    })).toThrow(PermanentError);
    expect(() => loadProcessingConfig({
      PARSER_PUBLIC_BASE_URL: "https://parser.example/images",
      PARSER_TRANSLATION_PROVIDER: "unknown",
    })).toThrow(PermanentError);
  });

  it("requires the public URL used by the old local image publication flow", () => {
    expect(() => loadProcessingConfig({})).toThrow(PermanentError);
  });
});
