import { describe, expect, it } from "vitest";
import { IntegrationContractError } from "../../src/core/errors/index.js";
import { buildWordPressVariationPatchIdentity } from "../../src/application/wordpress-variation-patch-runner.js";

describe("buildWordPressVariationPatchIdentity", () => {
  it("adds an exact SKU only for an explicit legacy SKU match", () => {
    expect(buildWordPressVariationPatchIdentity({
      targetId: "42",
      sourceCode: "goat",
      sourceExternalId: "1565836",
      matchMethod: "unique_sku",
      sku: " LEGACY-42 ",
    })).toEqual({
      target_id: 42,
      source_code: "goat",
      source_external_id: "1565836",
      external_key: "goat:1565836",
      expected_sku: "LEGACY-42",
    });
  });

  it("does not weaken source identity matches with SKU", () => {
    expect(buildWordPressVariationPatchIdentity({
      targetId: "42",
      sourceCode: "goat",
      sourceExternalId: "1565836",
      matchMethod: "source_identity",
      sku: "LEGACY-42",
    })).not.toHaveProperty("expected_sku");
  });

  it("rejects a legacy SKU match without an exact SKU", () => {
    expect(() => buildWordPressVariationPatchIdentity({
      targetId: "42",
      sourceCode: "goat",
      sourceExternalId: "1565836",
      matchMethod: "unique_sku",
      sku: null,
    })).toThrow(IntegrationContractError);
  });
});
