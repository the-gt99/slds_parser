import { describe, expect, it } from "vitest";

import { loadProcessingConfig } from "../../src/config/index.js";
import { PermanentError } from "../../src/core/errors/index.js";

describe("processing config", () => {
  it("requires a key for the explicitly selected OpenRouter provider", () => {
    const environment = { PARSER_PUBLIC_BASE_URL: "https://parser.example/images", PARSER_TRANSLATION_PROVIDER: "openrouter" };
    expect(() => loadProcessingConfig(environment)).toThrow("PARSER_OPENROUTER_API_KEY");
    expect(loadProcessingConfig({ ...environment, PARSER_OPENROUTER_API_KEY: "test-key" }).translation).toMatchObject({
      provider: "openrouter", model: "deepseek/deepseek-v3.2", timeoutMs: 60_000, minBalanceUsd: 0,
    });
    expect(loadProcessingConfig({ ...environment, PARSER_OPENROUTER_API_KEY: "test-key", PARSER_OPENROUTER_MIN_BALANCE_USD: "3" }).translation)
      .toMatchObject({ minBalanceUsd: 3 });
    expect(() => loadProcessingConfig({ ...environment, PARSER_OPENROUTER_API_KEY: "test-key", PARSER_OPENROUTER_MIN_BALANCE_USD: "-1" }))
      .toThrow("PARSER_OPENROUTER_MIN_BALANCE_USD");
  });

  it("uses the confirmed legacy processing defaults", () => {
    expect(loadProcessingConfig({ PARSER_PUBLIC_BASE_URL: "https://parser.example/images" })).toEqual({
      image: { baseDirectory: "runtime/images", publicBaseUrl: "https://parser.example/images", publicPathPrefix: "", webpQuality: 85, transportConcurrency: 8, operationConcurrency: 2, storage: { type: "local" } },
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

  it("loads an explicit S3 image storage contract", () => {
    expect(loadProcessingConfig({
      PARSER_IMAGE_STORAGE: "s3",
      PARSER_PUBLIC_BASE_URL: "https://storage.yandexcloud.net/slamdunk",
      PARSER_S3_BUCKET: "slamdunk",
      PARSER_S3_ACCESS_KEY_ID: "access-key",
      PARSER_S3_SECRET_ACCESS_KEY: "secret-key",
    }).image.storage).toEqual({
      type: "s3",
      endpoint: "https://storage.yandexcloud.net",
      region: "ru-central1",
      bucket: "slamdunk",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    });
  });

  it("requires complete credentials when S3 image storage is selected", () => {
    expect(() => loadProcessingConfig({
      PARSER_IMAGE_STORAGE: "s3",
      PARSER_PUBLIC_BASE_URL: "https://storage.yandexcloud.net/slamdunk",
      PARSER_S3_BUCKET: "slamdunk",
    })).toThrow(PermanentError);
  });
});
