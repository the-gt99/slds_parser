import { describe, expect, it } from "vitest";

import { summarizeExportControlPreflight } from "../../src/services/index.js";
import { validProduct } from "../support/in-memory.js";

describe("summarizeExportControlPreflight", () => {
  it("stores a compact dangerous diff with filterable flags", () => {
    const result = summarizeExportControlPreflight({
      target: { id: "10" } as never,
      source: { code: "goat" } as never,
      sourceProduct: { id: "2", sourceKey: "shoe", externalId: "100" } as never,
      internal: { id: "3", contentHash: "content", data: validProduct() } as never,
      configurationRevision: "7",
      preview: {
        payloadHash: "a".repeat(64),
        externalId: "321",
        willCreate: false,
        matchedBy: "source_identity",
        readiness: { ready: true, phase: "ready", blockers: [] },
        comparison: {
          fields: [
            { field: "title", changed: true },
            { field: "sku", changed: false },
          ],
          taxonomies: [{
            taxonomy: "product_tag",
            changed: true,
            added: [{ termId: 12, name: "Новая метка" }],
            removed: [{ termId: 11, name: "Старая метка" }],
          }],
          images: { rows: [{ status: "unchanged" }, { status: "remove" }] },
          variations: { rows: [{ status: "change" }, { status: "deactivate" }] },
        },
      },
    });

    expect(result).toMatchObject({
      status: "ready",
      riskLevel: "danger",
      fieldChangeCount: 1,
      taxonomyAddedCount: 1,
      taxonomyRemovedCount: 1,
      imageChangeCount: 1,
      variationChangeCount: 2,
      deactivatedVariationCount: 1,
    });
    expect(result.changeFlags).toEqual(expect.arrayContaining([
      "field:title",
      "taxonomy:product_tag",
      "taxonomy_added:product_tag",
      "taxonomy_removed:product_tag",
      "images_removed",
      "variation_changed",
      "variation_deactivated",
    ]));
    expect(result.changeSummary).toMatchObject({
      images: { added: 0, changed: 0, removed: 1 },
      variations: { added: 0, changed: 1, deactivated: 1 },
    });
  });

  it("marks an existing unchanged product without manufacturing a risk", () => {
    const result = summarizeExportControlPreflight({
      target: { id: "10" } as never,
      source: { code: "goat" } as never,
      sourceProduct: { id: "2", sourceKey: "shoe", externalId: "100" } as never,
      internal: { id: "3", contentHash: "content", data: validProduct() } as never,
      configurationRevision: "7",
      preview: {
        payloadHash: "a".repeat(64),
        externalId: "321",
        willCreate: false,
        matchedBy: "source_identity",
        readiness: { ready: true, phase: "ready", blockers: [] },
        comparison: { fields: [], taxonomies: [], images: { rows: [] }, variations: { rows: [] } },
      },
    });

    expect(result.riskLevel).toBe("none");
    expect(result.changeFlags).toContain("no_changes");
  });
});
