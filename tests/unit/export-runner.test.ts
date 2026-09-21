import { describe, expect, it, vi } from "vitest";
import { ExportRunner } from "../../src/application/index.js";
import type { ProductVariantDTO, TargetExporter } from "../../src/contracts/index.js";
import { TargetExporterRegistry } from "../../src/core/registry/index.js";
import { TargetReferenceMappingService } from "../../src/services/index.js";
import { createMemoryRepositories, MemoryStore, seedProduct, sourceRecord, targetRecord, validProduct } from "../support/in-memory.js";

async function setup(
  version = "1",
  implementation = vi.fn().mockResolvedValue({ externalId: "ext-1", operation: "created", metadata: {} }),
  liveVariants: readonly ProductVariantDTO[] | null = null,
  refreshEnabled = true,
  currentTime: () => number = Date.now,
) {
  const store = new MemoryStore(); store.sources.set("1", sourceRecord()); seedProduct(store); store.targets.set("10", targetRecord());
  const repositories = createMemoryRepositories(store); const internal = await repositories.internalProducts.upsert({ sourceProductId: "2", data: validProduct(), inputHash: "input", contentHash: "content", processorVersion: "1", status: "processed" });
  const exporter: TargetExporter = { targetCode: "fake-exporter", version, export: implementation }; const registry = new TargetExporterRegistry(); registry.register(exporter);
  const sourceRefresher = { refresh: vi.fn().mockResolvedValue(liveVariants) };
  const mappings = new TargetReferenceMappingService(repositories.references);
  return { store, repositories, internal, implementation, sourceRefresher,
    mappings,
    runner: new ExportRunner(repositories, registry, mappings, sourceRefresher as never, () => refreshEnabled, currentTime) };
}

describe("ExportRunner", () => {
  it("passes direct v2 resolution to the exporter", async () => {
    const implementation = vi.fn(async (context: Parameters<TargetExporter["export"]>[0]) => {
      expect(await context.references.resolveDirect?.(context.product)).toBeNull();
      return { externalId: "ext-1", operation: "created" as const, metadata: {} };
    });
    const value = await setup("1", implementation);
    await value.runner.exportProduct({ internalProductId: value.internal.id, targetId: "10", force: false });
    expect(implementation).toHaveBeenCalledOnce();
  });
  it("uses direct v2 assignments without invoking legacy assignment resolution", async () => {
    const implementation = vi.fn(async (context: Parameters<TargetExporter["export"]>[0]) => {
      expect(await context.references.resolveAssignments(context.product)).toEqual([]);
      return { externalId: "ext-1", operation: "created" as const, metadata: {} };
    });
    const value = await setup("1", implementation);
    vi.spyOn(value.mappings, "resolveDirectAssignments").mockResolvedValue([]);
    vi.spyOn(value.mappings, "resolveTargetAssignments").mockRejectedValue(new Error("Legacy assignments ran"));
    await value.runner.exportProduct({ internalProductId: value.internal.id, targetId: "10", force: false });
    expect(value.mappings.resolveTargetAssignments).not.toHaveBeenCalled();
  });
  it("selects exporter and saves success", async () => { const value = await setup(); await value.runner.exportProduct({ internalProductId: value.internal.id, targetId: "10", force: false }); expect(value.implementation).toHaveBeenCalledOnce(); expect([...value.store.targetProducts.values()][0]).toMatchObject({ externalId: "ext-1", status: "synced", lastExportedHash: "content" }); });
  it("skips the same fingerprint after checking live data again", async () => { const value = await setup(); const payload = { internalProductId: value.internal.id, targetId: "10", force: false }; await value.runner.exportProduct(payload); await value.runner.exportProduct(payload); expect(value.sourceRefresher.refresh).toHaveBeenCalledTimes(2); expect(value.implementation).toHaveBeenCalledOnce(); });
  it("does not skip a manually approved export when the local fingerprint is unchanged", async () => {
    const value = await setup();
    await value.runner.exportProduct({ internalProductId: value.internal.id, targetId: "10", force: false });
    await value.runner.exportProduct({
      internalProductId: value.internal.id,
      targetId: "10",
      force: false,
      approval: {
        preflightReviewId: "15",
        payloadHash: "a".repeat(64),
        willCreate: false,
        externalId: "ext-1",
        matchedBy: "source_identity",
      },
    });
    expect(value.implementation).toHaveBeenCalledTimes(2);
  });
  it("passes the saved WordPress snapshot into an approved export", async () => {
    const value = await setup();
    const snapshot = { product: { target_id: 321, title: "Снимок аудита" } };
    await value.repositories.targets.saveProductSnapshot({
      targetId: "10",
      sourceProductId: "2",
      externalId: "321",
      sourceExternalId: "100",
      payload: snapshot,
      contentHash: "snapshot-hash",
      fetchedAt: "2026-08-22T00:00:00.000Z",
    });

    await value.runner.exportProduct({
      internalProductId: value.internal.id,
      targetId: "10",
      force: false,
      approval: {
        preflightReviewId: "15",
        payloadHash: "a".repeat(64),
        willCreate: false,
        externalId: "321",
        matchedBy: "source_identity",
      },
    });

    expect(value.implementation).toHaveBeenCalledWith(expect.objectContaining({ existingTargetSnapshot: snapshot }));
  });
  it("exports after exporter version or mapping revision changes", async () => { const value = await setup(); const payload = { internalProductId: value.internal.id, targetId: "10", force: false }; await value.runner.exportProduct(payload); value.store.mappingRevision = "revision-2"; await value.runner.exportProduct(payload); expect(value.implementation).toHaveBeenCalledTimes(2); const changedVersion = vi.fn().mockResolvedValue({ externalId: "ext-1", operation: "updated", metadata: {} }); const registry = new TargetExporterRegistry(); registry.register({ targetCode: "fake-exporter", version: "2", export: changedVersion }); const runner = new ExportRunner(value.repositories, registry, new TargetReferenceMappingService(value.repositories.references), value.sourceRefresher as never); await runner.exportProduct(payload); expect(changedVersion).toHaveBeenCalledOnce(); });
  it("exports again after an active content template changes without processing the product", async () => {
    const value = await setup();
    const payload = { internalProductId: value.internal.id, targetId: "10", force: false };
    await value.runner.exportProduct(payload);
    const draft = await value.repositories.contentTemplates.createDraft({
      targetId: "10",
      field: "description",
      name: "Описание",
      templateSource: "<p>{{ product.effective_title }}</p>",
      profileKey: "default",
      profileName: "Основной профиль",
      managementMode: "manage",
      categoryTermIds: [],
      requiredContextPaths: [],
      actor: "admin",
    });
    await value.repositories.contentTemplates.activate(draft.id, "10", "admin");
    await value.runner.exportProduct(payload);

    expect(value.implementation).toHaveBeenCalledTimes(2);
    expect(value.implementation).toHaveBeenLastCalledWith(expect.objectContaining({
      contentTemplates: [expect.objectContaining({ id: draft.id, revision: 1 })],
    }));
  });
  it("passes freshly fetched price, availability and sizes into the same export attempt", async () => {
    const liveVariants: readonly ProductVariantDTO[] = [{
      sourceVariantKey: "offer-8",
      sku: "SKU-8",
      size: { sourceValue: "8", displayValue: "8" },
      price: { amount: "2693.00", currency: "USD" },
      inventory: { availability: "available" as const, quantity: 1 },
      attributes: {},
    }];
    const value = await setup("1", undefined, liveVariants);

    await value.runner.exportProduct({ internalProductId: value.internal.id, targetId: "10", force: false });

    expect(value.sourceRefresher.refresh).toHaveBeenCalledOnce();
    expect(value.implementation).toHaveBeenCalledWith(expect.objectContaining({ liveVariants }));
    expect([...value.store.targetProducts.values()][0]?.lastExportedHash).not.toBe("content");
    expect(value.store.jobs).toHaveLength(0);
  });
  it("uses the saved variants and makes no source request when the setting is disabled", async () => {
    const value = await setup("1", undefined, validProduct().variants, false);

    await value.runner.exportProduct({ internalProductId: value.internal.id, targetId: "10", force: false });

    expect(value.sourceRefresher.refresh).not.toHaveBeenCalled();
    expect(value.implementation).toHaveBeenCalledWith(expect.not.objectContaining({ liveVariants: expect.anything() }));
    expect([...value.store.targetProducts.values()][0]?.lastExportedHash).toBe("content");
  });
  it("saves failure and rethrows the original error", async () => { const error = new Error("export failed"); const value = await setup("1", vi.fn().mockRejectedValue(error)); await expect(value.runner.exportProduct({ internalProductId: value.internal.id, targetId: "10", force: false })).rejects.toBe(error); expect([...value.store.targetProducts.values()][0]).toMatchObject({ status: "failed", lastError: "export failed" }); });
  it("keeps the export error when saving the failure also fails", async () => { const error = new Error("export failed"); const saveError = new Error("database failed"); const value = await setup("1", vi.fn().mockRejectedValue(error)); vi.spyOn(value.repositories.targets, "saveExportFailure").mockRejectedValue(saveError); await expect(value.runner.exportProduct({ internalProductId: value.internal.id, targetId: "10", force: false })).rejects.toBe(error); expect(error.cause).toBe(saveError); });
});
