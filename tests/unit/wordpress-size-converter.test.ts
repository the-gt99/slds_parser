import { describe, expect, it, vi } from "vitest";

import { IntegrationContractError } from "../../src/core/errors/index.js";
import { WordPressSizeConverter } from "../../src/integrations/index.js";

const config = {
  baseUrl: "https://shop.example",
  authToken: "token",
  timeoutMs: 5_000,
  jobTimeoutMs: 10_000,
  pollIntervalMs: 100,
};

describe("WordPressSizeConverter", () => {
  it("keeps model-specific tables separate in requests and cache", async () => {
    const request = vi.fn(async (url: URL | RequestInfo) => {
      const ids = new URL(String(url)).searchParams.getAll("model_ids[]");
      return new Response(JSON.stringify({ conversion_table: { "40": ids.includes("51") ? "7" : "8" } }));
    });
    const converter = new WordPressSizeConverter(config, request);
    const input = { brandTermId: 31, categoryTermId: 75, size: { sourceValue: "40", displayValue: "40", system: "eu-numeric", audience: "men" as const } };
    expect((await converter.convert({ ...input, modelTermIds: [51] })).sourceValue).toBe("7");
    expect((await converter.convert({ ...input, modelTermIds: [52] })).sourceValue).toBe("8");
    expect((await converter.convert({ ...input, modelTermIds: [51, 51] })).sourceValue).toBe("7");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("uses the WordPress brand table and caches it per conversion context", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      brand_id: 31,
      category_id: 75,
      audience: "men",
      from_system: "EU",
      to_system: "US",
      conversion_table: { "41": "8", "41.5": "8.5" },
      conflicts: {},
    }), { status: 200 }));
    const converter = new WordPressSizeConverter(config, request);

    await expect(converter.convert({
      brandTermId: 31,
      categoryTermId: 75,
      size: { sourceValue: "41", displayValue: "EU 41", system: "eu-numeric", audience: "men" },
    })).resolves.toEqual({ sourceValue: "8", displayValue: "8", system: "us-numeric", audience: "men" });
    await expect(converter.convert({
      brandTermId: 31,
      categoryTermId: 75,
      size: { sourceValue: "41.5", displayValue: "41,5", system: "eu-numeric", audience: "men" },
    })).resolves.toEqual({ sourceValue: "8.5", displayValue: "8.5", system: "us-numeric", audience: "men" });

    expect(request).toHaveBeenCalledOnce();
    const url = new URL(String(request.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/wp-json/slamdunk/size-converter/v1/convert");
    expect(Object.fromEntries(url.searchParams)).toEqual({ brand_id: "31", category_id: "75", from_system: "EU", audience: "men" });
  });

  it("does not guess unsupported regional systems", async () => {
    const converter = new WordPressSizeConverter(config, vi.fn());

    await expect(converter.convert({
      brandTermId: 31,
      categoryTermId: 75,
      size: { sourceValue: "41", displayValue: "41", system: "cn-numeric", audience: "men" },
    })).rejects.toBeInstanceOf(IntegrationContractError);
  });

  it("uses the EU column for established Italian and French footwear units", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversion_table: { "41": "8" } }), { status: 200 }));
    const converter = new WordPressSizeConverter(config, request);

    await converter.convert({
      brandTermId: 31,
      categoryTermId: 75,
      size: { sourceValue: "41", displayValue: "41", system: "it-numeric", audience: "men" },
    });

    const url = new URL(String(request.mock.calls[0]?.[0]));
    expect(url.searchParams.get("from_system")).toBe("EU");
  });

  it("normalizes child US labels to target numeric size values", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversion_table: { "28": "11C" } }), { status: 200 }));
    const converter = new WordPressSizeConverter(config, request);

    await expect(converter.convert({
      brandTermId: 31,
      categoryTermId: 865,
      size: { sourceValue: "28", displayValue: "28", system: "eu-numeric", audience: "infant" },
    })).resolves.toMatchObject({ sourceValue: "11", displayValue: "11", system: "us-numeric", audience: "infant" });
  });

  it("reports a missing row without inventing a nearby size", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversion_table: { "41": "8" } }), { status: 200 }));
    const converter = new WordPressSizeConverter(config, request);

    await expect(converter.convert({
      brandTermId: 31,
      categoryTermId: 75,
      size: { sourceValue: "42", displayValue: "42", system: "eu-numeric", audience: "men" },
    })).rejects.toThrow("WordPress size conversion is missing: eu-numeric/men/42");
  });
});
