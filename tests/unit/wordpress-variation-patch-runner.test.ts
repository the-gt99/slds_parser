import { describe, expect, it } from "vitest";
import { IntegrationContractError, MappingMissingError, PermanentError } from "../../src/core/errors/index.js";
import { parseCollectWordPressVariationSourcePayload } from "../../src/application/job-payloads.js";
import { buildWordPressVariationPatchIdentity, shouldRefreshWordPressVariationSnapshot, wordpressCatalogItemError, wordpressVariationJobOutcome } from "../../src/application/wordpress-variation-patch-runner.js";

describe("parseCollectWordPressVariationSourcePayload", () => {
  it("keeps the force flag for a manual canary", () => {
    expect(parseCollectWordPressVariationSourcePayload({
      runId: "4", itemId: "577974", wordpressProductId: "2154349", force: true,
    })).toEqual({ runId: "4", itemId: "577974", wordpressProductId: "2154349", force: true });
  });
});

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

describe("wordpressVariationJobOutcome", () => {
  it("uses the real WordPress queue terminal statuses", () => {
    expect(wordpressVariationJobOutcome("done")).toBe("completed");
    expect(wordpressVariationJobOutcome("error")).toBe("failed");
    expect(wordpressVariationJobOutcome("running")).toBe("pending");
  });
});

describe("wordpressCatalogItemError", () => {
  it("keeps contract and mapping failures on one catalog item", () => {
    expect(wordpressCatalogItemError(new IntegrationContractError("invalid payload"))).toBe("invalid payload");
    expect(wordpressCatalogItemError(new MappingMissingError("target=1"))).toBe("Mapping is missing: target=1");
    expect(wordpressCatalogItemError(new Error("database unavailable"))).toBeNull();
  });

  it("skips a product removed from GOAT without hiding other transport failures", () => {
    expect(wordpressCatalogItemError(new PermanentError("GOAT product was not found", { code: "GOAT_PRODUCT_NOT_FOUND" })))
      .toBe("GOAT product was not found");
    expect(wordpressCatalogItemError(new PermanentError("GOAT request failed", { code: "GOAT_HTTP_PERMANENT" }))).toBeNull();
  });
});

describe("shouldRefreshWordPressVariationSnapshot", () => {
  it("retries stale target variation identities only once", () => {
    const error = "Variation patch permanent [variation_identity_conflict]: Variation 12 does not belong to product 10.";
    expect(shouldRefreshWordPressVariationSnapshot(error, [])).toBe(true);
    expect(shouldRefreshWordPressVariationSnapshot(error, [{ code: "fresh_target_snapshot" }])).toBe(false);
  });

  it("does not retry unrelated permanent failures", () => {
    expect(shouldRefreshWordPressVariationSnapshot(
      "Variation patch permanent [legacy_sku_identity_conflict]: identity does not match.",
      [],
    )).toBe(false);
  });
});
