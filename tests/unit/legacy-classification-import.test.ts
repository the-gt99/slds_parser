import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { classifyLegacyCandidate, legacyImportCandidates } from "../../src/cli/legacy-classification-import.js";
import type { ClassificationReviewItem, TargetDictionaryValueRecord } from "../../src/repositories/index.js";

function dictionary(overrides: Partial<TargetDictionaryValueRecord> = {}): TargetDictionaryValueRecord {
  return {
    id: "1",
    targetId: "1",
    entityType: "colors",
    externalId: "10",
    name: "Розовый",
    slug: "pink",
    parentExternalId: null,
    taxonomy: "pa_tsvet",
    attributeCode: null,
    remoteUpdatedAt: null,
    syncCursor: null,
    metadata: {},
    active: true,
    firstSeenAt: "2026-08-06T00:00:00.000Z",
    lastSeenAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function review(overrides: Partial<ClassificationReviewItem> = {}): ClassificationReviewItem {
  return {
    reviewGroupId: "1",
    sourceId: "1",
    sourceCode: "goat",
    sourceName: "GOAT",
    typeCode: "color",
    typeName: "Цвет",
    scope: "product.color",
    normalizedSourceValue: "pink",
    contextKey: "{}",
    sourceValue: "Pink",
    context: {},
    status: "unresolved",
    issueReason: "mapping_missing",
    observationCount: 1,
    productCount: 1,
    firstSeenAt: "2026-08-06T00:00:00.000Z",
    lastSeenAt: "2026-08-06T00:00:00.000Z",
    examples: [{ observationId: "1", sourceProductId: "316480", sourceKey: "goat:test", title: "Test", sku: null, evidence: {}, targetSnapshots: [] }],
    ...overrides,
  };
}

describe("legacy classification import planning", () => {
  it("accepts only candidates backed by a current target dictionary term and unresolved review", () => {
    const candidate = legacyImportCandidates().find((item) => item.sourceValue === "Pink")!;
    const planned = classifyLegacyCandidate({
      candidate,
      dictionary: dictionary(),
      dictionaryDuplicateCount: 1,
      reviews: [review()],
      existingMappingIds: [],
    });
    expect(planned).toMatchObject({ status: "accepted", reason: "safe_current_dictionary_match" });
  });

  it("rejects candidates when the current WordPress term is missing", () => {
    const candidate = legacyImportCandidates().find((item) => item.sourceValue === "Silver")!;
    const planned = classifyLegacyCandidate({
      candidate,
      dictionary: undefined,
      dictionaryDuplicateCount: 0,
      reviews: [review({ sourceValue: "Silver", normalizedSourceValue: "silver" })],
      existingMappingIds: [],
    });
    expect(planned).toMatchObject({ status: "rejected", reason: "target_term_missing" });
  });

  it("does not create bare model candidates", () => {
    expect(legacyImportCandidates().filter((item) => item.typeCode === "model")).toEqual([]);
  });

  it("marks conflicting legacy mappings when target dictionary term is not unique", () => {
    const candidate = legacyImportCandidates().find((item) => item.sourceValue === "Pink")!;
    const planned = classifyLegacyCandidate({
      candidate,
      dictionary: undefined,
      dictionaryDuplicateCount: 2,
      reviews: [review()],
      existingMappingIds: [],
    });
    expect(planned).toMatchObject({ status: "conflict", reason: "target_term_not_unique" });
  });

  it("rejects technology tags outside the explicit safe candidate scopes", () => {
    const candidate = legacyImportCandidates().find((item) => item.sourceValue === "Air")!;
    const planned = classifyLegacyCandidate({
      candidate,
      dictionary: dictionary({ entityType: "tags", name: "Air", taxonomy: "product_tag" }),
      dictionaryDuplicateCount: 1,
      reviews: [review({ typeCode: "tag", scope: "product.tag", sourceValue: "Air", normalizedSourceValue: "air" })],
      existingMappingIds: [],
    });
    expect(planned).toMatchObject({ status: "rejected", reason: "tag_scope_not_safe" });
  });

  it("keeps application writes on the service layer instead of direct mapping SQL", async () => {
    const source = await readFile("src/cli/legacy-classification-import.ts", "utf8");
    expect(source).not.toMatch(/INSERT\s+INTO\s+source_reference_mappings/iu);
    expect(source).not.toMatch(/UPDATE\s+source_reference_mappings/iu);
    expect(source).not.toMatch(/INSERT\s+INTO\s+source_reference_rules/iu);
    expect(source).not.toMatch(/INSERT\s+INTO\s+target_classification_projections/iu);
    expect(source).toContain("classifier.saveDecision");
  });
});
