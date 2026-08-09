import { describe, expect, it, vi } from "vitest";

import { TargetExporterRegistry } from "../../src/core/registry/index.js";
import { WordPressExporter } from "../../src/integrations/index.js";
import { WordPressPreviewService } from "../../src/services/index.js";

function setup(targetId: number, matchedBy: string, options: { readonly missingCategory?: boolean; readonly internalMissing?: boolean; readonly remoteSnapshot?: boolean; readonly matchingPerceptualImages?: boolean; readonly mismatchedStoredOrigin?: boolean } = {}) {
  const product = {
    sourceProductId: "2",
    title: "Test shoe",
    description: "Description",
    sku: "SKU-2",
    images: [{
      url: "https://parser.example/images/100.webp",
      position: 0,
      alt: "Test shoe",
      attributes: {},
      ...(options.matchingPerceptualImages ? {
        sourceUrl: "https://source.example/new.png",
        perceptualHash: "0000000000000000",
      } : {}),
    }],
    variants: [{
      sourceVariantKey: "offer-7",
      sku: "SKU-2-7",
      size: { sourceValue: "7", displayValue: "7" },
      price: { amount: "100.00", currency: "USD" },
      inventory: { availability: "available" as const },
      attributes: {},
    }],
    referenceCandidates: [],
    classification: {
      status: "complete" as const,
      classifierVersion: "1",
      fingerprint: "classification",
      resolved: [{
        candidateKey: "product:brand", typeCode: "brand", scope: "product.brand",
        subjectKind: "product" as const, referenceValueId: "11", resolutionKind: "mapping" as const,
        resolutionId: "21", resolutionRevision: "1",
      }],
      ignored: [],
      unresolved: [],
    },
    attributes: {},
    metadata: {},
  };
  const repositories = {
    sources: { getById: vi.fn().mockResolvedValue({ id: "1", code: "goat", name: "GOAT", adapterCode: "goat", config: {}, enabled: true }) },
    sourceProducts: { getById: vi.fn().mockResolvedValue({ id: "2", sourceId: "1", sourceKey: "test", externalId: "100", slug: "test-shoe", url: "https://goat.example/test", discoveryMetadata: {} }) },
    internalProducts: { findBySourceProductId: vi.fn().mockResolvedValue(options.internalMissing ? null : { id: "7", sourceProductId: "2", data: product }) },
    contentTemplates: { listActive: vi.fn().mockResolvedValue([]) },
    targets: {
      getById: vi.fn().mockResolvedValue({
        id: "10", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress", enabled: false,
        config: {
          requiredReferenceTypes: options.missingCategory ? ["brand", "category"] : ["brand"],
          sizeMappings: [{ sourceValue: "7", taxonomy: "pa_razmer", termId: 107 }],
          ...(options.missingCategory ? { titlePrefixByCategoryTermId: { "75": "Кроссовки" } } : {}),
        },
      }),
      findTargetProduct: vi.fn().mockResolvedValue(targetId === 0 ? null : { externalId: String(targetId) }),
      findProductSnapshot: vi.fn().mockResolvedValue(targetId === 0 ? null : {
        externalId: String(targetId),
        fetchedAt: "2026-08-06T00:00:00.000Z",
        payload: { product: {
          title: "Old title", slug: "test-shoe", sku: "SKU-2",
          description_html: "<p>Old</p>", short_description_html: "<p>Сохранить</p>",
          images: [{
            attachment_id: 55,
            url: "https://shop.example/wp-content/uploads/old.webp",
            position: 0,
            featured: true,
            ...(options.matchingPerceptualImages ? { perceptual_hash: "00000000000007ff" } : {}),
            ...(options.mismatchedStoredOrigin ? { origin_url: "https://source.example/old.png" } : {}),
          }],
          taxonomies: options.missingCategory ? { product_cat: [{ term_id: 75, name: "Кроссовки женские", slug: "sneakers-w" }] } : {}, variations: [],
        } },
      }),
      saveProductSnapshot: vi.fn().mockImplementation(async (input) => ({
        id: "90",
        ...input,
        createdAt: input.fetchedAt,
        updatedAt: input.fetchedAt,
      })),
    },
  };
  const request = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { payload: { payload_hash: string } };
    return new Response(JSON.stringify({
      ok: true,
      target_id: targetId,
      product_id: targetId,
      matched_by: matchedBy,
      payload_hash: body.payload.payload_hash,
      variation_plan: [],
    }), { status: 200 });
  });
  const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, request);
  const exporters = new TargetExporterRegistry();
  exporters.register(exporter);
  const mappings = {
    resolveTargetValue: vi.fn().mockResolvedValue("31"),
    resolveTargetProjections: vi.fn().mockResolvedValue([]),
  };
  const dictionaries = { listValuesByExternalIds: vi.fn().mockResolvedValue([]) };
  const snapshotReader = options.remoteSnapshot ? {
    read: vi.fn().mockResolvedValue([{
      sourceExternalId: "100",
      found: true,
      externalId: "321",
      matchedBy: "legacy_goat_id",
      snapshot: { product: {
        title: "Remote old title", slug: "test-shoe", sku: "SKU-2",
        description_html: "<p>Remote old</p>", short_description_html: "<p>Сохранить</p>",
        images: [], taxonomies: {}, variations: [],
      } },
    }]),
  } : undefined;
  return {
    service: new WordPressPreviewService(repositories as never, exporters, mappings as never, dictionaries as never, snapshotReader),
    request,
    repositories,
    snapshotReader,
  };
}

describe("WordPressPreviewService", () => {
  it("builds a read-only preview for an existing WordPress product", async () => {
    const { service, request } = setup(321, "source_identity");
    const result = await service.preview("2", "10");

    expect(result).toMatchObject({
      externalId: "321",
      willCreate: false,
      matchedBy: "source_identity",
      target: { id: "10", enabled: false },
      readiness: { ready: true, blockers: [] },
      payload: { fields: { title: "Test shoe", sku: "SKU-2" } },
      proposed: { fields: { short_description_html: "<p>Сохранить</p>" } },
      diff: {
        fields: expect.arrayContaining([
          expect.objectContaining({ field: "title" }),
          expect.objectContaining({ field: "description_html" }),
        ]),
        images: { changed: true, differences: [expect.objectContaining({ position: 0 })] },
      },
    });
    expect(result.comparison?.fields).toContainEqual(expect.objectContaining({
      field: "short_description_html",
      managed: false,
      changed: false,
      expected: "<p>Сохранить</p>",
      actual: "<p>Сохранить</p>",
    }));
    expect(String(request.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-lookup");
    expect(String(request.mock.calls[0]?.[0])).not.toContain("upsert-jobs");
  });

  it("returns the current WordPress card and a draft when a required classification is missing", async () => {
    const { service, request } = setup(321, "source_identity", { missingCategory: true });

    await expect(service.preview("2", "10")).resolves.toMatchObject({
      externalId: "321",
      readiness: {
        ready: false,
        phase: "classification",
        blockers: [{
          code: "required_reference_missing",
          referenceType: "category",
          message: "Не заполнено обязательное поле WordPress «Категория».",
        }],
      },
      current: { externalId: "321", product: { title: "Old title" } },
      proposed: {
        complete: false,
        sourceVariationCount: 1,
        variationPricesReady: false,
        variations: [expect.any(Object)],
        fields: { title: "Кроссовки Test shoe", short_description_html: "<p>Сохранить</p>" },
      },
      comparison: { variations: { available: false, expectedCount: 1, actualCount: 0 } },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("refreshes identity and snapshot before classification readiness", async () => {
    const { service, request, repositories, snapshotReader } = setup(0, "created", { missingCategory: true, remoteSnapshot: true });

    await expect(service.preview("2", "10")).resolves.toMatchObject({
      externalId: "321",
      willCreate: false,
      matchedBy: "legacy_goat_id",
      readiness: { ready: false, phase: "classification" },
      current: { externalId: "321", product: { title: "Remote old title", sku: "SKU-2" } },
    });
    expect(snapshotReader?.read).toHaveBeenCalledWith("goat", ["100"]);
    expect(repositories.targets.saveProductSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "10",
      sourceProductId: "2",
      externalId: "321",
      sourceExternalId: "100",
    }));
    expect(request).not.toHaveBeenCalled();
  });

  it("shows the saved WordPress product before processing without attempting a preflight", async () => {
    const { service, request } = setup(321, "source_identity", { internalMissing: true });

    await expect(service.preview("2", "10")).resolves.toMatchObject({
      readiness: { ready: false, phase: "processing" },
      current: { externalId: "321", product: { title: "Old title" } },
      proposed: null,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("builds a creation preview when WordPress returns ID zero", async () => {
    const { service, request, repositories } = setup(0, "created");

    await expect(service.preview("2", "10")).resolves.toMatchObject({
      externalId: null,
      willCreate: true,
      matchedBy: "created",
      diff: { snapshotFetchedAt: null },
    });
    expect(repositories.targets.findProductSnapshot).toHaveBeenCalledWith("10", "2");
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps visually identical legacy WordPress images despite different URLs", async () => {
    const { service } = setup(321, "source_identity", { matchingPerceptualImages: true });

    await expect(service.preview("2", "10")).resolves.toMatchObject({
      diff: { images: { changed: false, differences: [] } },
      comparison: {
        images: {
          rows: [{ status: "unchanged", matchReason: "perceptual_hash", perceptualDistance: 11 }],
        },
      },
    });
  });

  it("treats a changed stored source URL as a new image revision", async () => {
    const { service } = setup(321, "source_identity", { matchingPerceptualImages: true, mismatchedStoredOrigin: true });

    await expect(service.preview("2", "10")).resolves.toMatchObject({
      diff: { images: { changed: true, differences: [expect.objectContaining({ position: 0 })] } },
      comparison: { images: { rows: [{ status: "change", matchReason: null }] } },
    });
  });
});
