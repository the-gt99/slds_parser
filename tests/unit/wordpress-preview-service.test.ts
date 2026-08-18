import { describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/contracts/index.js";
import { TargetExporterRegistry } from "../../src/core/registry/index.js";
import { WordPressExporter } from "../../src/integrations/index.js";
import { WordPressPreviewService } from "../../src/services/index.js";

function setup(targetId: number, matchedBy: string, options: { readonly missingCategory?: boolean; readonly internalMissing?: boolean; readonly remoteSnapshot?: boolean; readonly remoteSnapshotMissing?: boolean; readonly savedSnapshotMissing?: boolean; readonly preflightSnapshot?: boolean; readonly matchingPerceptualImages?: boolean; readonly mismatchedStoredOrigin?: boolean; readonly landingProjection?: boolean; readonly existingSizeVariation?: boolean; readonly preserveExistingBrands?: boolean; readonly unmappedSizeVariant?: boolean; readonly requireTranslation?: boolean } = {}) {
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
    }, ...(options.unmappedSizeVariant ? [{
      sourceVariantKey: "offer-12.5",
      sku: "SKU-2-12.5",
      size: { sourceValue: "12.5", displayValue: "12.5", system: "us-numeric", audience: "youth" as const },
      price: { amount: "2463.00", currency: "USD" },
      inventory: { availability: "available" as const },
      attributes: {},
    }] : [])],
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
    internalProducts: { findBySourceProductId: vi.fn().mockResolvedValue(options.internalMissing ? null : { id: "7", sourceProductId: "2", contentHash: "content-hash", data: product }) },
    contentTemplates: { listActive: vi.fn().mockResolvedValue([]) },
    targets: {
      getById: vi.fn().mockResolvedValue({
        id: "10", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress", enabled: false,
        config: {
          requiredReferenceTypes: options.missingCategory ? ["brand", "category"] : ["brand"],
          sizeMappings: [{ sourceValue: "7", taxonomy: "pa_razmer", termId: 107 }],
          ...(options.unmappedSizeVariant ? { ignoreUnmappedSizeVariants: true } : {}),
          ...(options.preserveExistingBrands ? { preserveExistingBrandTerms: true } : {}),
          ...(options.missingCategory ? { titlePrefixByCategoryTermId: { "75": "Кроссовки" } } : {}),
          ...(options.requireTranslation ? { requiredTranslation: {
            providerCode: "deepl", providerVersion: "1.0.0", sourceLocale: "en", targetLocale: "ru",
          } } : {}),
        },
      }),
      findTargetProduct: vi.fn().mockResolvedValue(targetId === 0 || options.savedSnapshotMissing ? null : { externalId: String(targetId) }),
      findProductSnapshot: vi.fn().mockResolvedValue(targetId === 0 || options.savedSnapshotMissing ? null : {
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
          taxonomies: {
            ...(options.missingCategory ? { product_cat: [{ term_id: 75, name: "Кроссовки женские", slug: "sneakers-w" }] } : {}),
            ...(options.preserveExistingBrands ? { pa_brand: [
              { term_id: 31, name: "Nike", slug: "nike" },
              { term_id: 5490, name: "Clarks", slug: "clarks" },
            ] } : {}),
          },
          variations: options.existingSizeVariation ? [{
            regular_price: "93450",
            stock_status: "instock",
            manage_stock: true,
            stock_quantity: 2,
            attributes: [{ taxonomy: "pa_razmer", term_id: 114 }],
          }] : [],
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
    const body = JSON.parse(String(init?.body)) as { payload: { payload_hash: string; product: JsonObject; content_policy?: JsonObject } };
    const currentDescription = options.preflightSnapshot ? "<p>Legacy SKU</p>" : "<p>Старое описание</p>";
    const fallbackSource = String(((body.payload.content_policy?.description as JsonObject | undefined)?.fallback_source) ?? "empty");
    return new Response(JSON.stringify({
      ok: true,
      target_id: targetId,
      product_id: targetId,
      matched_by: matchedBy,
      payload_hash: body.payload.payload_hash,
      variation_plan: [],
      resolved_content: {
        description_html: targetId > 0 ? currentDescription : String(body.payload.product.description_html ?? ""),
        description_source: targetId > 0 ? "wordpress_existing" : fallbackSource,
      },
      ...(options.preflightSnapshot ? { snapshot: { product: {
        title: "Legacy SKU title", slug: "legacy-sku-title", sku: "SKU-2",
        description_html: "<p>Legacy SKU</p>", short_description_html: "<p>Сохранить</p>",
        images: [], taxonomies: options.preserveExistingBrands ? { pa_brand: [
          { term_id: 31, name: "Nike", slug: "nike" },
          { term_id: 5490, name: "Clarks", slug: "clarks" },
        ] } : {}, variations: [],
      } } } : {}),
    }), { status: 200 });
  });
  const exporter = new WordPressExporter({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 5_000, jobTimeoutMs: 10_000, pollIntervalMs: 100 }, request);
  const exporters = new TargetExporterRegistry();
  exporters.register(exporter);
  const mappings = {
    getTargetMappingRevision: vi.fn().mockResolvedValue("7"),
    resolveTargetValue: vi.fn().mockResolvedValue("31"),
    resolveTargetMapping: vi.fn().mockResolvedValue({ externalValue: "31", externalLabel: "Nike" }),
    resolveTargetProjections: vi.fn().mockResolvedValue(options.landingProjection ? [{
      resolutionKind: "reference", resolutionId: "11", targetScope: "product.tag", externalValue: "2968",
      externalLabel: "Onitsuka Tiger", externalSlug: "onitsuka-tiger",
      provenance: { kind: "related_target_term", relationCode: "landing", sourceTypeCode: "brand", sourceLabel: "Onitsuka Tiger" },
    }] : []),
    resolveTargetAssignments: vi.fn().mockResolvedValue([]),
  };
  const dictionaryValues = [
    ...(options.landingProjection ? [{
      id: "90", targetId: "10", entityType: "tags", externalId: "2968", name: "Onitsuka Tiger",
      slug: "onitsuka-tiger", parentExternalId: null, taxonomy: "product_tag", attributeCode: null,
      remoteUpdatedAt: null, syncCursor: null, metadata: {}, active: true,
      firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01",
    }] : []),
    ...(options.existingSizeVariation ? [{
      id: "91", targetId: "10", entityType: "sizes", externalId: "114", name: "US 10,5M",
      slug: "us-10-5m", parentExternalId: null, taxonomy: "pa_razmer", attributeCode: "pa_razmer",
      remoteUpdatedAt: null, syncCursor: null, metadata: {}, active: true,
      firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01",
    }] : []),
  ];
  const dictionaries = { listValuesByExternalIds: vi.fn().mockResolvedValue(dictionaryValues) };
  const exportControl = {
    getCachedPreflight: vi.fn().mockResolvedValue({
      status: "ready",
      externalId: targetId === 0 ? null : String(targetId),
      willCreate: targetId === 0,
      matchedBy,
      wordpressCheckedAt: "2026-08-06T00:00:00.000Z",
      wordpressStateHash: null,
      preflightCache: { variationPlan: [] },
      riskLevel: "none",
      changeFlags: [],
      variationChangeCount: 0,
      deactivatedVariationCount: 0,
      changeSummary: { variations: { added: 0, changed: 0, deactivated: 0, deactivatedItems: [] } },
      blockers: [],
    }),
    savePreflight: vi.fn(),
  };
  const snapshotReader = options.remoteSnapshot || options.remoteSnapshotMissing ? {
    read: vi.fn().mockResolvedValue([options.remoteSnapshotMissing ? {
      sourceExternalId: "100",
      found: false,
      errorCode: "target_not_found",
    } : {
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
    service: new WordPressPreviewService(repositories as never, exporters, mappings as never, dictionaries as never, snapshotReader, exportControl as never),
    request,
    repositories,
    snapshotReader,
    exportControl,
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
    expect(result.comparison?.fields).toContainEqual(expect.objectContaining({
      field: "sku",
      managed: false,
      changed: false,
      expected: "SKU-2",
      actual: "SKU-2",
    }));
    expect(result.comparison?.fields).toContainEqual(expect.objectContaining({
      field: "slug",
      managed: false,
      changed: false,
      expected: "test-shoe",
      actual: "test-shoe",
    }));
    expect(String(request.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-lookup");
    expect(String(request.mock.calls[0]?.[0])).not.toContain("upsert-jobs");
  });

  it("shows source variants omitted by the temporary unmapped-size policy", async () => {
    const { service } = setup(321, "source_identity", { unmappedSizeVariant: true });

    const result = await service.preview("2", "10");

    expect(result.readiness).toMatchObject({
      ready: true,
      notices: [expect.objectContaining({ code: "unmapped_size_variants_ignored" })],
    });
    expect(result.proposed).toMatchObject({ sourceVariationCount: 2 });
    expect(result.proposed?.ignoredSizeVariants).toEqual([
      expect.objectContaining({ sourceValue: "12.5", audience: "youth" }),
    ]);
    expect(result.comparison?.variations).toMatchObject({
      ignored: [expect.objectContaining({ sourceValue: "12.5" })],
    });
  });

  it("blocks the full WordPress payload when the current translation is missing", async () => {
    const { service, request, snapshotReader } = setup(321, "source_identity", { requireTranslation: true, remoteSnapshot: true });

    await expect(service.preview("2", "10")).resolves.toMatchObject({
      readiness: {
        ready: false,
        phase: "translation",
        blockers: [{
          code: "translation_required",
          message: "Для выгрузки WordPress требуется актуальный перевод deepl 1.0.0 en→ru",
        }],
      },
      proposed: null,
      payload: null,
    });
    expect(request).not.toHaveBeenCalled();
    expect(snapshotReader?.read).not.toHaveBeenCalled();
  });

  it("marks where an automatically added landing tag came from", async () => {
    const { service } = setup(321, "source_identity", { landingProjection: true });

    const result = await service.preview("2", "10");

    expect(result.comparison?.taxonomies).toContainEqual(expect.objectContaining({
      taxonomy: "product_tag",
      added: [expect.objectContaining({
        termId: 2968,
        origins: [{ relationCode: "landing", sourceTypeCode: "brand", sourceLabel: "Onitsuka Tiger" }],
      })],
    }));
  });

  it("does not propose removing an existing WordPress brand when preservation is enabled", async () => {
    const { service } = setup(321, "source_identity", { preserveExistingBrands: true });

    const result = await service.preview("2", "10");

    expect(result.comparison?.taxonomies).toContainEqual(expect.objectContaining({
      taxonomy: "pa_brand",
      before: [expect.objectContaining({ termId: 31 }), expect.objectContaining({ termId: 5490 })],
      after: [expect.objectContaining({ termId: 31 }), expect.objectContaining({ termId: 5490 })],
      removed: [],
      changed: false,
    }));
  });

  it("adds a readable label to a size that will be deactivated", async () => {
    const { service } = setup(321, "source_identity", { existingSizeVariation: true });

    const result = await service.preview("2", "10");

    expect(result.comparison?.variations.rows).toContainEqual(expect.objectContaining({
      size: "pa_razmer:114",
      sizeLabel: "US 10,5M",
      status: "deactivate",
    }));
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

  it("uses the legacy SKU preflight snapshot when source identity is absent", async () => {
    const { service, repositories, snapshotReader } = setup(321, "legacy_sku", {
      savedSnapshotMissing: true,
      remoteSnapshotMissing: true,
      preflightSnapshot: true,
    });

    await expect(service.preview("2", "10")).resolves.toMatchObject({
      externalId: "321",
      willCreate: false,
      matchedBy: "legacy_sku",
      current: { externalId: "321", product: { title: "Legacy SKU title", sku: "SKU-2" } },
    });
    expect(snapshotReader?.read).toHaveBeenCalledWith("goat", ["100"]);
    expect(repositories.targets.saveProductSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "10",
      sourceProductId: "2",
      externalId: "321",
      sourceExternalId: "100",
    }));
  });

  it("recovers a missing saved snapshot through read-only preflight before preserving brands", async () => {
    const { service, request } = setup(321, "source_identity", {
      remoteSnapshotMissing: true,
      preflightSnapshot: true,
      preserveExistingBrands: true,
    });

    const result = await service.preview("2", "10");

    expect(result.readiness).toEqual({ ready: true, phase: "ready", blockers: [] });
    expect(result.comparison?.taxonomies).toContainEqual(expect.objectContaining({
      taxonomy: "pa_brand",
      after: [expect.objectContaining({ termId: 31 }), expect.objectContaining({ termId: 5490 })],
      removed: [],
    }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses the WordPress ID discovered by a fresh legacy snapshot in the same preflight payload", async () => {
    const { service, request } = setup(321, "legacy_goat_id", {
      savedSnapshotMissing: true,
      remoteSnapshot: true,
    });

    await expect(service.preview("2", "10", [], { saveExportControl: true })).resolves.toMatchObject({
      externalId: "321",
      willCreate: false,
      matchedBy: "legacy_goat_id",
      readiness: { ready: true },
    });

    const requestBody = JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body)) as {
      payload: { identity: { target_id: number } };
    };
    expect(requestBody.payload.identity.target_id).toBe(321);
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

  it("recalculates a stale template from the saved WordPress snapshot without a WordPress request", async () => {
    const { service, request, exportControl } = setup(321, "source_identity");

    await expect(service.preview("2", "10", [], { saveExportControl: true, refreshWordPress: false })).resolves.toMatchObject({
      externalId: "321",
      willCreate: false,
      readiness: { ready: true },
      current: { snapshotFetchedAt: "2026-08-06T00:00:00.000Z" },
    });
    expect(request).not.toHaveBeenCalled();
    expect(exportControl.getCachedPreflight).toHaveBeenCalledWith("10", "7");
    expect(exportControl.savePreflight).toHaveBeenCalledWith(expect.objectContaining({
      configurationRevision: "7",
      usedCachedWordPress: true,
      wordpressCheckedAt: "2026-08-06T00:00:00.000Z",
    }));
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
