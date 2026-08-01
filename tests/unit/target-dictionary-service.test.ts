import { describe, expect, it, vi } from "vitest";

import type { TargetDictionaryProvider } from "../../src/integrations/index.js";
import { TargetDictionaryProviderRegistry } from "../../src/integrations/index.js";
import type { TargetDictionaryRepository } from "../../src/repositories/index.js";
import type { ClassifierAdminService } from "../../src/services/index.js";
import { TargetDictionaryService } from "../../src/services/index.js";

function setup() {
  const provider: TargetDictionaryProvider = {
    code: "wordpress",
    supportedEntityTypes: ["brands", "models"],
    creatableEntityTypes: ["brands", "models"],
    fetchPage: vi.fn()
      .mockResolvedValueOnce({ values: [{ externalId: "1", name: "Nike", metadata: {} }], hasMore: true, nextPage: 2 })
      .mockResolvedValueOnce({ values: [{ externalId: "2", name: "Adidas", metadata: {} }], hasMore: false, nextPage: null }),
    createTerm: vi.fn().mockResolvedValue({ externalId: "77", name: "New model", metadata: {} }),
  };
  const registry = new TargetDictionaryProviderRegistry();
  registry.register(provider);
  const repository = {
    listTargets: vi.fn().mockResolvedValue([{
      id: "10", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress",
      config: {}, enabled: false, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    }]),
    listValues: vi.fn(),
    replaceEntityValues: vi.fn().mockResolvedValue(2),
    upsertValue: vi.fn().mockResolvedValue({
      id: "88", targetId: "10", entityType: "models", externalId: "77", name: "New model",
      slug: null, parentExternalId: null, taxonomy: null, attributeCode: null,
      remoteUpdatedAt: null, syncCursor: null, metadata: {}, active: true,
      firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01",
    }),
  } satisfies TargetDictionaryRepository;
  const classifier = {
    getDecisionContext: vi.fn().mockResolvedValue({ observationId: "55", sourceCode: "goat", sourceValue: "New model" }),
    saveDecision: vi.fn().mockResolvedValue({ mappingId: "99", referenceValueId: "100", revision: "1", affectedProductCount: 3, affectedExportCount: 0 }),
  } as unknown as ClassifierAdminService;
  return { provider, repository, classifier, service: new TargetDictionaryService(repository, registry, classifier) };
}

describe("TargetDictionaryService", () => {
  it("loads every target dictionary page before replacing the local snapshot", async () => {
    const { provider, repository, service } = setup();

    const result = await service.sync("10", ["brands"]);

    expect(provider.fetchPage).toHaveBeenCalledTimes(2);
    expect(repository.replaceEntityValues).toHaveBeenCalledWith("10", "brands", [
      expect.objectContaining({ externalId: "1", name: "Nike" }),
      expect.objectContaining({ externalId: "2", name: "Adidas" }),
    ]);
    expect(result.counts).toEqual({ brands: 2 });
  });

  it("creates a WordPress term, snapshots it, then confirms both mappings", async () => {
    const { provider, repository, classifier, service } = setup();
    const key = {
      sourceId: "1", typeCode: "model", scope: "product.model",
      normalizedSourceValue: "new model", contextKey: "{}",
    };

    const result = await service.createTermAndDecide({
      ...key,
      targetId: "10",
      targetScope: "product.model",
      entityType: "models",
      name: "New model",
    });

    expect(provider.createTerm).toHaveBeenCalledWith(expect.objectContaining({
      sourceCode: "goat",
      sourceValue: "New model",
      requestReference: "55",
    }));
    expect(repository.upsertValue).toHaveBeenCalledWith("10", "models", expect.objectContaining({ externalId: "77" }));
    expect(classifier.saveDecision).toHaveBeenCalledWith(expect.objectContaining({
      ...key,
      targetLink: { targetId: "10", targetScope: "product.model", dictionaryValueId: "88" },
    }));
    expect(result.decision.mappingId).toBe("99");
  });
});
