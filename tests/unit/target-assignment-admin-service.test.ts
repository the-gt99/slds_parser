import { describe, expect, it, vi } from "vitest";

import type { TargetDictionaryProvider } from "../../src/integrations/index.js";
import { TargetDictionaryProviderRegistry } from "../../src/integrations/index.js";
import type {
  TargetAssignmentRuleRecord,
  TargetAssignmentRuleRepository,
  TargetDictionaryRepository,
} from "../../src/repositories/index.js";
import { TargetAssignmentAdminService } from "../../src/services/index.js";

const existingRule: TargetAssignmentRuleRecord = {
  id: "20", targetId: "10", name: "Женские сандалии", groupCode: "sandal_leaf", priority: 100,
  conditionGroups: [{ conditions: [{ field: "candidate.category.context.audience", operator: "equals", values: ["women"] }] }],
  conditions: [{ field: "candidate.category.context.audience", operator: "equals", values: ["women"] }],
  actions: [{ targetScope: "product.category", dictionaryValueId: "30", externalValue: "75", externalLabel: "Женские сандалии", mode: "replace" }],
  enabled: true, revision: "1", createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

function setup(rules: readonly TargetAssignmentRuleRecord[] = [existingRule]) {
  const repository = {
    list: vi.fn().mockResolvedValue(rules),
    preview: vi.fn()
      .mockResolvedValueOnce({ productCount: 12, examples: [] })
      .mockResolvedValueOnce({ productCount: 3, examples: [] }),
    create: vi.fn(),
    update: vi.fn(),
    setEnabled: vi.fn(),
    history: vi.fn(),
    listMatchSets: vi.fn().mockResolvedValue([]),
    createMatchSet: vi.fn(),
    updateMatchSet: vi.fn(),
    listMatchSetOverlaps: vi.fn(),
  } satisfies TargetAssignmentRuleRepository;
  const dictionaries = {
    listTargets: vi.fn().mockResolvedValue([{
      id: "10", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress", config: {}, enabled: false,
      createdAt: "2026-01-01", updatedAt: "2026-01-01",
    }]),
    getValue: vi.fn().mockResolvedValue({ id: "30", targetId: "10", entityType: "product_categories", active: true }),
  } as unknown as TargetDictionaryRepository;
  const provider: TargetDictionaryProvider = {
    code: "wordpress", supportedEntityTypes: ["product_categories"], creatableEntityTypes: ["product_categories"],
    classificationCapabilities: [{ typeCode: "category", entityType: "product_categories", targetScope: "product.category", cardinality: "multiple" }],
    fetchPage: vi.fn(), createTerm: vi.fn(),
  };
  const providers = new TargetDictionaryProviderRegistry();
  providers.register(provider);
  return { repository, service: new TargetAssignmentAdminService(repository, dictionaries, providers) };
}

const draft = {
  targetId: "10", name: "Сандалии", groupCode: "sandal_leaf", priority: 100,
  conditionGroups: [{ conditions: [{ field: "candidate.category.sourceValue", operator: "equals" as const, values: ["sandals"] }] }],
  actions: [{ targetScope: "product.category", dictionaryValueId: "30", mode: "replace" as const }],
};

describe("TargetAssignmentAdminService", () => {
  it("shows overlap with an equally prioritized enabled rule", async () => {
    const { service } = setup();

    const preview = await service.preview(draft);

    expect(preview.conflicts).toEqual([{ ruleId: "20", ruleName: "Женские сандалии", productCount: 3 }]);
  });

  it("does not save a rule with an equally prioritized overlap", async () => {
    const { repository, service } = setup();

    await expect(service.create(draft)).rejects.toThrow("conflicts");
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("accepts a neutral source fact as a rule condition", async () => {
    const { repository, service } = setup([]);

    await service.preview({
      ...draft,
      conditionGroups: [{ conditions: [{ field: "product.fact.designer", operator: "equals", values: ["Wilson Smith"] }] }],
    });

    expect(repository.preview).toHaveBeenCalledWith(expect.objectContaining({
      conditionGroups: [{ conditions: [{ field: "product.fact.designer", operator: "equals", values: ["Wilson Smith"] }] }],
    }));
  });

  it("does not query product overlap for statically disjoint audiences", async () => {
    const { repository, service } = setup();
    repository.preview.mockReset().mockResolvedValue({ productCount: 12, examples: [] });

    const preview = await service.preview({
      ...draft,
      conditionGroups: [{ conditions: [{ field: "candidate.category.context.audience", operator: "equals", values: ["men"] }] }],
    });

    expect(preview.conflicts).toEqual([]);
    expect(repository.preview).toHaveBeenCalledTimes(1);
  });

  it("does not assume that different phrase conditions cannot coexist in one title", async () => {
    const phraseRule = {
      ...existingRule,
      conditionGroups: [{ conditions: [{ field: "candidate.model.sourceValue", operator: "contains_phrase" as const, values: ["canvas"] }] }],
      conditions: [{ field: "candidate.model.sourceValue", operator: "contains_phrase" as const, values: ["canvas"] }],
    };
    const { repository, service } = setup([phraseRule]);

    await service.preview({
      ...draft,
      conditionGroups: [{ conditions: [{ field: "candidate.model.sourceValue", operator: "contains_phrase", values: ["boot"] }] }],
    });

    expect(repository.preview).toHaveBeenCalledTimes(2);
  });
});
