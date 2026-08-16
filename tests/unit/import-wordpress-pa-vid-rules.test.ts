import { describe, expect, it } from "vitest";

import {
  extractLegacyPatterns,
  extractLegacyTagIds,
  parseLegacyPaVidConfig,
  unwrapPhpRegex,
} from "../../src/cli/import-wordpress-pa-vid-rules.js";

describe("WordPress pa_vid rule import", () => {
  const config = parseLegacyPaVidConfig({
    name: "Вид спорта",
    slug: "vid",
    apply_mode: "append",
    values: ["Бег"],
    value_logic: {
      Бег: {
        groups: [
          { rules: [{ type: "text", pattern: "/\\b(running|jogging)\\b/i" }] },
          { rules: [{ type: "tag", values: [{ id: "903" }, { id: 904 }, { id: "903" }] }] },
        ],
      },
    },
  });

  it("extracts regex bodies and unique WordPress tag ids", () => {
    expect(extractLegacyPatterns(config, "Бег")).toEqual(["\\b(running|jogging)\\b"]);
    expect(extractLegacyTagIds(config, "Бег")).toEqual(["903", "904"]);
  });

  it("rejects unsupported PHP regex modifiers", () => {
    expect(() => unwrapPhpRegex("/running/x")).toThrow(/flags/u);
  });
});
