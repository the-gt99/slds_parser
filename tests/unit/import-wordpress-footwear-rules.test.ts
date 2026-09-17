import { describe, expect, it } from "vitest";

import { parseFootwearRuleConfig } from "../../src/cli/import-wordpress-footwear-rules.js";

describe("parseFootwearRuleConfig", () => {
  it("accepts an exact footwear model set", () => {
    expect(parseFootwearRuleConfig({ categories: [{
      code: "canvas", label: "кед", menCategory: "Мужские кеды", womenCategory: "Женские кеды",
      priority: 300, aliases: ["canvas"], models: ["Converse Chuck 70"],
    }] }).categories[0]?.models).toEqual(["Converse Chuck 70"]);
  });

  it("rejects duplicate models after normalization", () => {
    expect(() => parseFootwearRuleConfig({ categories: [{
      code: "canvas", label: "кед", menCategory: "Мужские кеды", womenCategory: "Женские кеды",
      priority: 300, aliases: ["canvas"], models: ["Vans Era", " vans era "],
    }] })).toThrow("contains duplicates");
  });
});
