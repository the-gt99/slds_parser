import { describe, expect, it } from "vitest";

import { sameTerms } from "../../src/cli/audit-pa-vid-rules.js";

describe("pa_vid audit", () => {
  it("compares taxonomy term sets without depending on order or duplicates", () => {
    expect(sameTerms(["2", "1", "1"], ["1", "2"])).toBe(true);
    expect(sameTerms(["1"], ["2"])).toBe(false);
  });
});
