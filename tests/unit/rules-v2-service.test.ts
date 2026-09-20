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
});
