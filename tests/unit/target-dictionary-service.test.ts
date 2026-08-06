import { describe, expect, it, vi } from "vitest";

import type { TargetDictionaryProvider } from "../../src/integrations/index.js";
import { TargetDictionaryProviderRegistry } from "../../src/integrations/index.js";
import type { TargetDictionaryRepository } from "../../src/repositories/index.js";
import type { ClassifierAdminService } from "../../src/services/index.js";
import { TargetDictionaryService } from "../../src/services/index.js";

function setup() {
  const provider: TargetDictionaryProvider = {
    code: "wordpress",
    supportedEntityTypes: ["brands", "models", "product_categories"],
    creatableEntityTypes: ["brands", "models", "product_categories"],
    classificationCapabilities: [
      { typeCode: "brand", entityType: "brands", targetScope: "product.brand", cardinality: "single" },
    ],
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
    getValue: vi.fn(),
    listValues: vi.fn(),
    replaceEntityValues: vi.fn().mockResolvedValue(2),
    upsertValue: vi.fn().mockResolvedValue({
      id: "88", targetId: "10", entityType: "models", externalId: "77", name: "New model",
      slug: null, parentExternalId: null, taxonomy: null, attributeCode: null,
      remoteUpdatedAt: null, syncCursor: null, metadata: {}, active: true,
      firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01",
    }),
    startTermCreation: vi.fn().mockResolvedValue("audit-1"),
    completeTermCreation: vi.fn().mockResolvedValue(undefined),
    failTermCreation: vi.fn().mockResolvedValue(undefined),
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
    expect(classifier.saveDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        ...key,
        targetLink: { targetId: "10", targetScope: "product.model", dictionaryValueId: "88" },
      }),
      "admin-api",
    );
    expect(result.decision.mappingId).toBe("99");
    expect(repository.startTermCreation).toHaveBeenCalledWith(expect.objectContaining({ actor: "admin-api" }));
    expect(repository.completeTermCreation).toHaveBeenCalledWith("audit-1", "77");
  });

  it("passes an explicit slug and category parent through the audited creation flow", async () => {
    const { provider, repository, service } = setup();

    await service.createTermAndDecide({
      sourceId: "1",
      typeCode: "category",
      scope: "product.category",
      normalizedSourceValue: "trail running",
      contextKey: "{}",
      targetId: "10",
      targetScope: "product.category",
      entityType: "product_categories",
      name: "Trail running",
      slug: "trail-running",
      parentExternalId: "15",
    }, "roman");

    expect(provider.createTerm).toHaveBeenCalledWith(expect.objectContaining({
      entityType: "product_categories",
      slug: "trail-running",
      parentExternalId: "15",
    }));
    expect(repository.startTermCreation).toHaveBeenCalledWith(expect.objectContaining({
      slug: "trail-running",
      parentExternalId: "15",
      actor: "roman",
    }));
  });

  it("records a failed remote creation without hiding the original error", async () => {
    const { provider, repository, service } = setup();
    vi.mocked(provider.createTerm).mockRejectedValueOnce(new Error("WordPress rejected the term"));

    await expect(service.createTermAndDecide({
      sourceId: "1",
      typeCode: "model",
      scope: "product.model",
      normalizedSourceValue: "new model",
      contextKey: "{}",
      targetId: "10",
      targetScope: "product.model",
      entityType: "models",
      name: "New model",
    }, "roman")).rejects.toThrow("WordPress rejected the term");

    expect(repository.failTermCreation).toHaveBeenCalledWith("audit-1", "WordPress rejected the term", undefined);
    expect(repository.completeTermCreation).not.toHaveBeenCalled();
  });

  it("keeps the remote term ID in audit if local mapping fails after WordPress creation", async () => {
    const { repository, classifier, service } = setup();
    vi.mocked(classifier.saveDecision).mockRejectedValueOnce(new Error("Local mapping failed"));

    await expect(service.createTermAndDecide({
      sourceId: "1",
      typeCode: "model",
      scope: "product.model",
      normalizedSourceValue: "new model",
      contextKey: "{}",
      targetId: "10",
      targetScope: "product.model",
      entityType: "models",
      name: "New model",
    }, "roman")).rejects.toThrow("Local mapping failed");

    expect(repository.failTermCreation).toHaveBeenCalledWith("audit-1", "Local mapping failed", "77");
  });

  it("rejects a parent outside product categories", async () => {
    const { provider, service } = setup();

    await expect(service.createTermAndDecide({
      sourceId: "1",
      typeCode: "model",
      scope: "product.model",
      normalizedSourceValue: "new model",
      contextKey: "{}",
      targetId: "10",
      targetScope: "product.model",
      entityType: "models",
      name: "New model",
      parentExternalId: "15",
    })).rejects.toThrow("only for product_categories");

    expect(provider.createTerm).not.toHaveBeenCalled();
  });
});
