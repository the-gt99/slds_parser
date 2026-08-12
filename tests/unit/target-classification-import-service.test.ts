import { describe, expect, it, vi } from "vitest";
import { TargetClassificationImportService } from "../../src/services/index.js";

function run() {
  return {
    id: "1", targetId: "2", targetCode: "slamdunk", targetName: "Slamdunk", targetEnabled: false,
    sourceId: "3", sourceCode: "goat", sourceName: "GOAT", status: "completed" as const, cursor: "10",
    fetchedProductCount: 10, matchedSourceProductCount: 10, assignmentCount: 30,
    suggestionCount: 1, readySuggestionCount: 0, conflictSuggestionCount: 1,
    requestedBy: "admin", startedAt: "2026-08-12T00:00:00.000Z", finishedAt: "2026-08-12T00:01:00.000Z",
    lastError: null, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:01:00.000Z",
  };
}

function conflict() {
  return {
    id: "10", runId: "1", targetId: "2", sourceId: "3", typeCode: "model", suggestionKind: "rule" as const,
    scope: "product.model", normalizedSourceValue: "", contextKey: "context", context: { brand: "Nike", family: "Air Force 1" },
    sourceValue: "Nike · Air Force 1", targetScope: "product.model", dictionaryValueId: "20", externalValue: "14733",
    targetName: "Nike Air Force 1", matchedProductCount: 100, evidenceProductCount: 100, missingTargetCount: 0,
    targets: [
      { dictionaryValueId: "20", externalValue: "14733", name: "Nike Air Force 1", productCount: 90 },
      { dictionaryValueId: "21", externalValue: "14965", name: "Nike Air Force 1 High", productCount: 10 },
    ],
    status: "conflict" as const, issueReason: "target_terms_conflict", appliedResolutionKind: null, appliedResolutionId: null,
  };
}

describe("TargetClassificationImportService", () => {
  it("returns persisted product examples with WordPress links", async () => {
    const repository = {
      listSuggestionExamples: vi.fn().mockResolvedValue({
        suggestion: conflict(),
        items: [{ sourceProductId: "5", sourceExternalId: "100", targetExternalId: "200", title: "Air Force", sourceUrl: "https://goat.test/product", termExternalValue: "14733", termName: "Nike Air Force 1" }],
      }),
    };
    const service = new TargetClassificationImportService(repository as never, {} as never, "https://slamdunk.shop/");

    const result = await service.examples("10", 5);

    expect(repository.listSuggestionExamples).toHaveBeenCalledWith("10", 5);
    expect(result.items[0]).toMatchObject({
      targetUrl: "https://slamdunk.shop/?p=200",
      targetEditUrl: "https://slamdunk.shop/wp-admin/post.php?post=200&action=edit",
    });
  });

  it("resolves a conflict only with one of its WordPress terms", async () => {
    const repository = {
      getRun: vi.fn().mockResolvedValue(run()),
      getSuggestion: vi.fn().mockResolvedValue(conflict()),
      markApplied: vi.fn().mockResolvedValue(undefined),
    };
    const classifier = {
      previewRule: vi.fn().mockResolvedValue({ ambiguousObservations: 0 }),
      createRule: vi.fn().mockResolvedValue({ ruleId: "77", preview: { affectedProducts: 100 } }),
    };
    const service = new TargetClassificationImportService(repository as never, classifier as never);

    const result = await service.resolve({ runId: "1", suggestionId: "10", dictionaryValueId: "21" }, "admin");

    expect(result).toEqual({ appliedSuggestionId: "10", affectedProductCount: 100 });
    expect(classifier.createRule).toHaveBeenCalledWith(expect.objectContaining({
      conditions: [
        { field: "context.brand", operator: "equals", value: "Nike" },
        { field: "context.family", operator: "equals", value: "Air Force 1" },
      ],
      targetLink: { targetId: "2", targetScope: "product.model", dictionaryValueId: "21" },
    }), "admin");
    expect(repository.markApplied).toHaveBeenCalledWith(expect.objectContaining({
      suggestionId: "10", dictionaryValueId: "21", externalValue: "14965", targetName: "Nike Air Force 1 High",
      resolutionKind: "rule", resolutionId: "77", actor: "admin",
    }));
  });

  it("rejects a term from another conflict", async () => {
    const repository = { getRun: vi.fn().mockResolvedValue(run()), getSuggestion: vi.fn().mockResolvedValue(conflict()) };
    const service = new TargetClassificationImportService(repository as never, {} as never);

    await expect(service.resolve({ runId: "1", suggestionId: "10", dictionaryValueId: "999" }, "admin"))
      .rejects.toThrow("не относится к этому конфликту");
  });
});
