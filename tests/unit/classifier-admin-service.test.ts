import { describe, expect, it, vi } from "vitest";

import type {
  ClassificationAdminRepository,
  ClassificationRepository,
  ClassificationRuleCandidateRecord,
  ClassificationRuleRecord,
} from "../../src/repositories/index.js";
import { ClassifierAdminService } from "../../src/services/index.js";
import { TargetDictionaryProviderRegistry, type TargetDictionaryProvider } from "../../src/integrations/index.js";
import type { TargetDictionaryRepository } from "../../src/repositories/index.js";

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
    mappingId: null,
    mappingReferenceValueId: null,
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
    listConfiguration: vi.fn(),
    listReviewQueue: vi.fn(),
    countReviewQueue: vi.fn(),
    listReviewExamples: vi.fn(),
    listReferenceValues: vi.fn(),
    listReferenceCatalog: vi.fn(),
    listRuleCandidates: vi.fn().mockResolvedValue(candidates),
    getRule: vi.fn(),
    listRuleConditionFields: vi.fn(),
    listConfigurationHistory: vi.fn(),
    previewDecision: vi.fn(),
    getDecisionContext: vi.fn(),
    saveDecision: vi.fn().mockResolvedValue({ mappingId: "1", referenceValueId: "2", revision: "1", affectedProductCount: 1, affectedExportCount: 0 }),
    findRuleTargetReference: vi.fn().mockResolvedValue(null),
    createRule: vi.fn().mockResolvedValue({ ruleId: "10", referenceValueId: "500", revision: "1", affectedProductCount: 1 }),
    updateRule: vi.fn().mockResolvedValue({ ruleId: "10", revision: "2", affectedProductCount: 1 }),
    setRuleEnabled: vi.fn().mockResolvedValue({ revision: "2", affectedProductCount: 1 }),
    deleteRule: vi.fn().mockResolvedValue({ revision: "2", affectedProductCount: 1 }),
    getTargetValueMapping: vi.fn(),
    previewTargetValueMapping: vi.fn(),
    updateTargetValueMapping: vi.fn(),
    createTargetValueMapping: vi.fn(),
    setTargetValueMappingEnabled: vi.fn(),
    listTargetProjections: vi.fn(),
    getTargetProjection: vi.fn(),
    previewTargetProjection: vi.fn(),
    createTargetProjection: vi.fn(),
    updateTargetProjection: vi.fn(),
    deactivateTargetProjection: vi.fn(),
    listReferenceProjections: vi.fn(),
    previewReferenceProjection: vi.fn(),
    createReferenceProjection: vi.fn(),
    deactivateReferenceProjection: vi.fn(),
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

  it("shows exact mappings as shadowed instead of letting a rule override them", async () => {
    const exact = { ...candidate("1", "101", "Nike ACG Pegasus Trail", "Nike"), mappingId: "77", mappingReferenceValueId: "500" };
    const deps = repositories([exact]);
    const service = new ClassifierAdminService(deps.admin, deps.classification);

    const preview = await service.previewRule(draft);

    expect(preview).toMatchObject({ matchedProducts: 1, affectedProducts: 0, shadowedObservations: 1 });
    expect(preview.examples[0]?.outcome).toBe("shadowed");
    expect(preview.examples[0]?.reason).toContain("результат тот же");
  });

  it("does not compare an edited rule with its previous revision", async () => {
    const existing: ClassificationRuleRecord = {
      id: "10", sourceId: "1", typeCode: "model", name: "Old", priority: 100,
      conditions: draft.conditions, referenceValueId: "999", revision: "1",
    };
    const deps = repositories([candidate("1", "101", "Nike ACG Pegasus Trail", "Nike")], [existing]);
    deps.admin.getRule.mockResolvedValue({ ...existing, enabled: true });
    const service = new ClassifierAdminService(deps.admin, deps.classification);

    const result = await service.updateRule("10", draft);

    expect(result.preview.ambiguousObservations).toBe(0);
    expect(deps.admin.updateRule).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: "10",
      affectedSourceProductIds: ["101"],
      matchedObservationIds: ["1"],
    }));
  });

  it("rejects unsafe bare model rules", async () => {
    const deps = repositories([candidate("1", "101", "Nike ACG Pegasus Trail", "Nike")]);
    const service = new ClassifierAdminService(deps.admin, deps.classification);

    await expect(service.previewRule({
      ...draft,
      conditions: [{ field: "sourceValue", operator: "equals", value: "Pegasus" }],
    })).rejects.toThrow("Model rules require");
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
      matchedObservationIds: ["1"],
      actor: "admin-api",
    }));
  });

  it("previews a source rule before reactivation", async () => {
    const deps = repositories([]);
    deps.admin.getRule.mockResolvedValue({
      id: "10",
      sourceId: "1",
      typeCode: "tag",
      name: "GOAT lifestyle",
      priority: 10,
      conditions: [{ field: "sourceValue", operator: "equals", value: "Lifestyle" }],
      referenceValueId: "500",
      revision: "1",
      enabled: false,
    });
    const service = new ClassifierAdminService(deps.admin, deps.classification);

    await service.setRuleEnabled("10", true);

    expect(deps.admin.listRuleCandidates).toHaveBeenCalledWith("1", "tag", undefined, [
      { field: "sourceValue", operator: "equals", value: "Lifestyle" },
    ]);
    expect(deps.admin.setRuleEnabled).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: "10",
      enabled: true,
      affectedSourceProductIds: [],
      matchedObservationIds: [],
    }));
  });

  it("filters review data and rule candidates by the current processor version", async () => {
    const deps = repositories([]);
    const service = new ClassifierAdminService(deps.admin, deps.classification, undefined, undefined, "admin-api", { "1": "2.9.0" });

    await service.listReviewQueue({ limit: 20, offset: 0 });
    await service.countReviewQueue({ limit: 20, offset: 0 });
    await service.listReviewExamples("42", { search: "Vans", limit: 50, offset: 100 });
    await service.listConfiguration({ kind: "mapping", limit: 20, offset: 0 });
    await service.listRuleConditionFields("1", "model");

    expect(deps.admin.listReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ currentProcessorVersions: { "1": "2.9.0" } }));
    expect(deps.admin.countReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ currentProcessorVersions: { "1": "2.9.0" } }));
    expect(deps.admin.listReviewExamples).toHaveBeenCalledWith({
      reviewGroupId: "42",
      search: "Vans",
      limit: 50,
      offset: 100,
      currentProcessorVersions: { "1": "2.9.0" },
    });
    expect(deps.admin.listConfiguration).toHaveBeenCalledWith(expect.objectContaining({ currentProcessorVersions: { "1": "2.9.0" } }));
    expect(deps.admin.listRuleConditionFields).toHaveBeenCalledWith("1", "model", "2.9.0");
  });

  it("creates an opaque internal reference when a target term is linked directly", async () => {
    const deps = repositories([]);
    const provider: TargetDictionaryProvider = {
      code: "wordpress", supportedEntityTypes: ["brands"], creatableEntityTypes: ["brands"],
      classificationCapabilities: [{ typeCode: "brand", entityType: "brands", targetScope: "product.brand", cardinality: "single" }],
      termRelationCapabilities: [{
        relationCode: "landing", sourceEntityType: "brands", relatedEntityType: "tags",
        targetScope: "product.tag", label: "Посадочная бренда", canCreateRelated: true,
        relatedExternalIdPath: ["rawMeta", "tag_id"],
      }],
      fetchPage: vi.fn(), createTerm: vi.fn(),
    };
    const providers = new TargetDictionaryProviderRegistry();
    providers.register(provider);
    const targets = {
      listTargets: vi.fn().mockResolvedValue([{ id: "2", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress", config: {}, enabled: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]),
      getValue: vi.fn().mockResolvedValue({ id: "3", targetId: "2", entityType: "brands", externalId: "4", name: "Nike", slug: null, parentExternalId: null, taxonomy: "pa_brand", attributeCode: null, remoteUpdatedAt: null, syncCursor: null, metadata: { rawMeta: { tag_id: 2968 } }, active: true, firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01" }),
      listValuesByExternalIds: vi.fn().mockResolvedValue([{ id: "9", targetId: "2", entityType: "tags", externalId: "2968", name: "Nike", slug: null, parentExternalId: null, taxonomy: "product_tag", attributeCode: null, remoteUpdatedAt: null, syncCursor: null, metadata: {}, active: true, firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01" }]), listValues: vi.fn(), replaceEntityValues: vi.fn(), upsertValue: vi.fn(),
      startTermCreation: vi.fn(), completeTermCreation: vi.fn(), failTermCreation: vi.fn(),
    } satisfies TargetDictionaryRepository;
    const service = new ClassifierAdminService(deps.admin, deps.classification, targets, providers);

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
      targetLink: expect.objectContaining({
        relatedProjectionSyncs: [expect.objectContaining({
          relationCode: "landing", targetScope: "product.tag", dictionaryValueId: "9",
          metadata: expect.objectContaining({ sourceTypeCode: "brand", sourceLabel: "Nike" }),
        })],
      }),
    }));
  });

  it("creates a contextual rule from a WordPress term without saving an exact source mapping", async () => {
    const categoryCandidate: ClassificationRuleCandidateRecord = {
      ...candidate("1", "101", "Test shoe", "Nike"),
      candidate: {
        key: "product:category",
        typeCode: "category",
        scope: "product.category",
        subjectKind: "product",
        sourceValue: "sneakers",
        context: { audience: "women", productType: "sneakers" },
        evidence: {},
      },
    };
    const deps = repositories([categoryCandidate]);
    deps.admin.findRuleTargetReference.mockResolvedValue("500");
    const provider: TargetDictionaryProvider = {
      code: "wordpress",
      supportedEntityTypes: ["product_categories"],
      creatableEntityTypes: ["product_categories"],
      classificationCapabilities: [
        { typeCode: "category", entityType: "product_categories", targetScope: "product.category", cardinality: "multiple" },
      ],
      fetchPage: vi.fn(),
      createTerm: vi.fn(),
    };
    const providers = new TargetDictionaryProviderRegistry();
    providers.register(provider);
    const targets: TargetDictionaryRepository = {
      listTargets: vi.fn().mockResolvedValue([{ id: "10", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress", config: {}, enabled: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]),
      getValue: vi.fn().mockResolvedValue({ id: "88", targetId: "10", entityType: "product_categories", externalId: "74", name: "Кроссовки женские", slug: null, parentExternalId: null, taxonomy: "product_cat", attributeCode: null, remoteUpdatedAt: null, syncCursor: null, metadata: {}, active: true, firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01" }),
      listValuesByExternalIds: vi.fn(), listValues: vi.fn(), replaceEntityValues: vi.fn(), upsertValue: vi.fn(),
      startTermCreation: vi.fn(), completeTermCreation: vi.fn(), failTermCreation: vi.fn(),
    };
    const service = new ClassifierAdminService(deps.admin, deps.classification, targets, providers);
    const targetDraft = {
      sourceId: "1", typeCode: "category", name: "Женские кроссовки", priority: 100,
      conditions: [
        { field: "sourceValue", operator: "equals" as const, value: "sneakers" },
        { field: "context.audience", operator: "equals" as const, value: "women" },
      ],
      targetLink: { targetId: "10", targetScope: "product.category", dictionaryValueId: "88" },
    };

    const result = await service.createRule(targetDraft);

    expect(result.preview.affectedProducts).toBe(1);
    expect(deps.admin.saveDecision).not.toHaveBeenCalled();
    expect(deps.admin.createRule).toHaveBeenCalledWith(expect.objectContaining({
      referenceValueId: "500",
      targetLink: targetDraft.targetLink,
      affectedSourceProductIds: ["101"],
      matchedObservationIds: ["1"],
    }));
  });

  it("validates and creates a cross-type target projection through the audited repository flow", async () => {
    const deps = repositories([]);
    const provider: TargetDictionaryProvider = {
      code: "wordpress",
      supportedEntityTypes: ["tags", "activities"],
      creatableEntityTypes: [],
      classificationCapabilities: [
        { typeCode: "tag", entityType: "tags", targetScope: "product.tag", cardinality: "multiple" },
        { typeCode: "activity", entityType: "activities", targetScope: "product.activity", cardinality: "multiple" },
      ],
      fetchPage: vi.fn(),
      createTerm: vi.fn(),
    };
    const providers = new TargetDictionaryProviderRegistry();
    providers.register(provider);
    const targets: TargetDictionaryRepository = {
      listTargets: vi.fn().mockResolvedValue([{ id: "10", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress", config: {}, enabled: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]),
      getValue: vi.fn().mockResolvedValue({ id: "88", targetId: "10", entityType: "tags", externalId: "777", name: "Кроссовки для бега", slug: null, parentExternalId: null, taxonomy: "product_tag", attributeCode: null, remoteUpdatedAt: null, syncCursor: null, metadata: {}, active: true, firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01" }),
      listValuesByExternalIds: vi.fn(),
      listValues: vi.fn(),
      replaceEntityValues: vi.fn(),
      upsertValue: vi.fn(),
      startTermCreation: vi.fn(),
      completeTermCreation: vi.fn(),
      failTermCreation: vi.fn(),
    };
    deps.admin.createTargetProjection.mockResolvedValue({
      projection: { id: "1", targetId: "10", resolutionKind: "mapping", resolutionId: "99", targetScope: "product.tag", dictionaryValueId: "88", externalValue: "777", externalLabel: "Кроссовки для бега", metadata: {}, revision: "1" },
      preview: { observationCount: 18, productCount: 18, affectedSourceProductIds: ["1"], examples: [], duplicate: null, cardinalityConflicts: [] },
      affectedProductCount: 1,
    });
    const service = new ClassifierAdminService(deps.admin, deps.classification, targets, providers);

    await service.createTargetProjection({ targetId: "10", resolutionKind: "mapping", resolutionId: "99", targetScope: "product.tag", dictionaryValueId: "88" }, "admin");

    expect(deps.admin.createTargetProjection).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "10",
      resolutionKind: "mapping",
      targetScope: "product.tag",
      dictionaryValueId: "88",
      actor: "admin",
    }));
  });

  it("rejects a WordPress activity term when projection scope is product.tag", async () => {
    const deps = repositories([]);
    const provider: TargetDictionaryProvider = {
      code: "wordpress",
      supportedEntityTypes: ["tags", "activities"],
      creatableEntityTypes: [],
      classificationCapabilities: [
        { typeCode: "tag", entityType: "tags", targetScope: "product.tag", cardinality: "multiple" },
        { typeCode: "activity", entityType: "activities", targetScope: "product.activity", cardinality: "multiple" },
      ],
      fetchPage: vi.fn(),
      createTerm: vi.fn(),
    };
    const providers = new TargetDictionaryProviderRegistry();
    providers.register(provider);
    const targets = {
      listTargets: vi.fn().mockResolvedValue([{ id: "10", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress", config: {}, enabled: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]),
      getValue: vi.fn().mockResolvedValue({ id: "88", targetId: "10", entityType: "activities", externalId: "777", name: "Бег", slug: null, parentExternalId: null, taxonomy: "pa_vid", attributeCode: null, remoteUpdatedAt: null, syncCursor: null, metadata: {}, active: true, firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01" }),
    } as unknown as TargetDictionaryRepository;
    const service = new ClassifierAdminService(deps.admin, deps.classification, targets, providers);

    await expect(service.previewTargetProjection({ targetId: "10", resolutionKind: "mapping", resolutionId: "99", targetScope: "product.tag", dictionaryValueId: "88" }))
      .rejects.toThrow("cannot be used");
    expect(deps.admin.previewTargetProjection).not.toHaveBeenCalled();
  });
});
