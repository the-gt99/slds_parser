import { describe, expect, it } from "vitest";

import { loadProcessingConfig } from "../../src/config/index.js";
import { PermanentError } from "../../src/core/errors/index.js";

describe("processing config", () => {
  it("uses the confirmed legacy processing defaults", () => {
    expect(loadProcessingConfig({ PARSER_PUBLIC_BASE_URL: "https://parser.example/images" })).toEqual({
      image: { baseDirectory: "runtime/images", publicBaseUrl: "https://parser.example/images", publicPathPrefix: "", webpQuality: 85, concurrency: 2 },
      translation: { sourceLocale: "en", targetLocale: "ru", timeoutMs: 8_000, attempts: 2, retryDelayMs: 400 },
    });
  });

  it("requires the public URL used by the old local image publication flow", () => {
    expect(() => loadProcessingConfig({})).toThrow(PermanentError);
  });
});
