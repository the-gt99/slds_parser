import { describe, expect, it } from "vitest";

import { loadProcessingConfig } from "../../src/config/index.js";
import { PermanentError } from "../../src/core/errors/index.js";

describe("processing config", () => {
  it("uses the confirmed legacy processing defaults", () => {
    expect(loadProcessingConfig({ PARSER_PUBLIC_BASE_URL: "https://parser.example/images" })).toEqual({
      image: { baseDirectory: "runtime/images", publicBaseUrl: "https://parser.example/images", publicPathPrefix: "", webpQuality: 85, concurrency: 2 },
      translation: { sourceLocale: "en", targetLocale: "ru", timeoutMs: 8_000, attempts: 2, retryDelayMs: 400 },
      shoeHeight: null,
    });
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

  it("requires the public URL used by the old local image publication flow", () => {
    expect(() => loadProcessingConfig({})).toThrow(PermanentError);
  });
});
