import { describe, expect, it, vi } from "vitest";

import type { RuleV2Draft, RulesV2Repository, TargetAssignmentRuleRepository } from "../../src/repositories/index.js";
import { RulesV2Service } from "../../src/services/index.js";

const draft: RuleV2Draft = {
  sourceId: "1", targetId: "10", name: "Топы", groupCode: "category", priority: 200, status: "shadow",
  conditionGroups: [{ conditions: [{ field: "product.attribute.taxonomy.taxonomyLevel4", operator: "equals", values: ["Shirts and Tops"] }] }],
  actions: [{ targetScope: "product_cat", dictionaryValueId: "99", mode: "replace" }],
};

describe("RulesV2Service", () => {
  it("previews through the indexed assignment query without writing", async () => {
    const repository = {} as RulesV2Repository;
    const preview = vi.fn().mockResolvedValue({ productCount: 425, examples: [] });
    const service = new RulesV2Service(repository, { preview } as unknown as TargetAssignmentRuleRepository);

    await expect(service.preview(draft)).resolves.toEqual({ productCount: 425, examples: [], mode: "shadow", writes: false });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ targetId: "10", conditionGroups: draft.conditionGroups }));
  });

  it("never accepts an authoritative status in the parallel contour", async () => {
    const service = new RulesV2Service({} as RulesV2Repository, {} as TargetAssignmentRuleRepository);
    await expect(service.create({ ...draft, status: "active" } as unknown as RuleV2Draft, "admin")).rejects.toThrow();
  });
  it("rejects invalid equals and regex before persistence", async () => {
    const create = vi.fn();
    const service = new RulesV2Service({ create } as unknown as RulesV2Repository, {} as TargetAssignmentRuleRepository);
    for (const condition of [
      { field: "product.title", operator: "equals", values: ["a", "b"] },
      { field: "product.title", operator: "regex", values: ["("] },
      { field: "product.title", operator: "absent", values: ["a"] },
      { field: "common.characteristics.missingField", operator: "absent", values: [] },
    ]) await expect(service.create({ ...draft, conditionGroups: [{ conditions: [condition] }] } as RuleV2Draft, "admin")).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("validates imported updates and delegates with optimistic revision", async () => {
    const updateImported = vi.fn().mockResolvedValue({ id: "1" });
    const service = new RulesV2Service({ updateImported } as unknown as RulesV2Repository, {} as TargetAssignmentRuleRepository);
    await expect(service.updateImported("1", { ...draft, actions: [{ kind: "resolve_reference", referenceType: "model", referenceValueId: "4", resolutionStatus: "confirmed" }] }, "2", "admin")).resolves.toEqual({ id: "1" });
    expect(updateImported).toHaveBeenCalledWith("1", expect.anything(), "2", "admin");
    for (const invalid of [null, { ...draft, conditionGroups: [{}] }, { ...draft, actions: [{ kind: "unexpected" }] }]) {
      await expect(service.updateImported("1", invalid, "2", "admin")).rejects.toThrow();
    }
    expect(updateImported).toHaveBeenCalledTimes(1);
  });
  it("returns a page without silently hiding the rest of the catalog", async () => {
    const list = vi.fn().mockResolvedValue(Array.from({ length: 101 }, (_, id) => ({ id: String(id) })));
    const service = new RulesV2Service({ list, summary: async () => ({}) } as unknown as RulesV2Repository, {} as TargetAssignmentRuleRepository);
    const result = await service.overview("2", { search: "adidas", offset: 100 });
    expect(result.items).toHaveLength(100);
    expect(result.page).toEqual({ offset: 100, limit: 100, hasMore: true });
    expect(list).toHaveBeenCalledWith("2", { search: "adidas", offset: 100, limit: 101 });
    await expect(service.overview("2", { offset: -1 })).rejects.toThrow();
  });
});
