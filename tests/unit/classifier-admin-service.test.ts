import { describe, expect, it, vi } from "vitest";

import type {
  ClassificationAdminRepository,
  ClassificationRepository,
  ClassificationRuleCandidateRecord,
  ClassificationRuleRecord,
} from "../../src/repositories/index.js";
import { ClassifierAdminService } from "../../src/services/index.js";

function candidate(
  id: string,
  sourceProductId: string,
  title: string,
  brand: string,
): ClassificationRuleCandidateRecord {
  return {
    observationId: id,
    sourceId: "1",
    sourceProductId,
    sourceKey: `product-${sourceProductId}`,
    title,
    sku: `SKU-${sourceProductId}`,
    candidate: {
      key: "product:model",
      typeCode: "model",
      scope: "product.model",
      subjectKind: "product",
      sourceValue: title,
      context: { brand },
      evidence: { title, brand },
    },
  };
}

function repositories(
  candidates: readonly ClassificationRuleCandidateRecord[],
  rules: readonly ClassificationRuleRecord[] = [],
) {
  const admin = {
    listReviewQueue: vi.fn(),
    listReferenceValues: vi.fn(),
    listRuleCandidates: vi.fn().mockResolvedValue(candidates),
    getDecisionContext: vi.fn(),
    saveDecision: vi.fn().mockResolvedValue({ mappingId: "1", referenceValueId: "2", revision: "1", affectedProductCount: 1, affectedExportCount: 0 }),
    createRule: vi.fn().mockResolvedValue({ ruleId: "10", revision: "1", affectedProductCount: 1 }),
  } satisfies ClassificationAdminRepository;
  const classification = {
    listReferenceTypes: vi.fn(),
    findSourceDecisions: vi.fn(),
    listActiveRules: vi.fn().mockResolvedValue(rules),
    saveProductResult: vi.fn(),
  } satisfies ClassificationRepository;
  return { admin, classification };
}

const draft = {
  sourceId: "1",
  typeCode: "model",
  name: "Nike ACG Pegasus Trail",
  priority: 100,
  conditions: [
    { field: "context.brand", operator: "equals" as const, value: "Nike" },
    { field: "evidence.title", operator: "contains" as const, value: "ACG Pegasus Trail" },
  ],
  referenceValueId: "500",
};

describe("ClassifierAdminService", () => {
  it("previews a contextual rule without grouping every Pegasus product together", async () => {
    const deps = repositories([
      candidate("1", "101", "Nike ACG Pegasus Trail", "Nike"),
      candidate("2", "102", "Nike Air Pegasus 2005", "Nike"),
      candidate("3", "103", "Under Armour Surge Golf", "Under Armour"),
    ]);
    const service = new ClassifierAdminService(deps.admin, deps.classification);

    const preview = await service.previewRule(draft);

    expect(preview).toMatchObject({
      matchedObservations: 1,
      matchedProducts: 1,
      affectedProducts: 1,
      ambiguousObservations: 0,
      shadowedObservations: 0,
    });
    expect(preview.examples[0]).toMatchObject({ sourceProductId: "101", outcome: "applicable" });
  });

  it("reports an equal-priority rule resolving to another value as ambiguous", async () => {
    const existing: ClassificationRuleRecord = {
      id: "9",
      sourceId: "1",
      typeCode: "model",
      name: "Existing",
      priority: 100,
      conditions: draft.conditions,
      referenceValueId: "999",
      revision: "1",
    };
    const deps = repositories([candidate("1", "101", "Nike ACG Pegasus Trail", "Nike")], [existing]);
    const service = new ClassifierAdminService(deps.admin, deps.classification);

    const preview = await service.previewRule(draft);

    expect(preview.ambiguousObservations).toBe(1);
    expect(preview.examples[0]?.outcome).toBe("ambiguous");
  });

  it("recomputes preview and queues only products affected by a new rule", async () => {
    const deps = repositories([
      candidate("1", "101", "Nike ACG Pegasus Trail", "Nike"),
      candidate("2", "102", "Nike Air Pegasus 2005", "Nike"),
    ]);
    const service = new ClassifierAdminService(deps.admin, deps.classification);

    await service.createRule(draft);

    expect(deps.admin.createRule).toHaveBeenCalledWith(expect.objectContaining({
      affectedSourceProductIds: ["101"],
      actor: "admin-api",
    }));
  });

  it("creates an opaque internal reference when a target term is linked directly", async () => {
    const deps = repositories([]);
    const service = new ClassifierAdminService(deps.admin, deps.classification);

    await service.saveDecision({
      sourceId: "1",
      typeCode: "brand",
      scope: "product.brand",
      normalizedSourceValue: "nike",
      contextKey: "{}",
      action: "confirm",
      targetLink: { targetId: "2", targetScope: "product.brand", dictionaryValueId: "3" },
    });

    expect(deps.admin.saveDecision).toHaveBeenCalledWith(expect.objectContaining({
      generatedReferenceCode: expect.stringMatching(/^ref-[0-9a-f-]+$/u),
      actor: "admin-api",
    }));
  });
});
