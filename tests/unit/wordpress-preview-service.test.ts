import { describe, expect, it, vi } from "vitest";

import { TargetExporterRegistry } from "../../src/core/registry/index.js";
import { WordPressExporter } from "../../src/integrations/index.js";
import { WordPressPreviewService } from "../../src/services/index.js";

function setup(targetId: number, matchedBy: string) {
  const product = {
    sourceProductId: "2",
    title: "Test shoe",
    description: "Description",
    sku: "SKU-2",
    images: [{ url: "https://parser.example/images/100.webp", position: 0, alt: "Test shoe", attributes: {} }],
    variants: [],
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
    internalProducts: { findBySourceProductId: vi.fn().mockResolvedValue({ id: "7", sourceProductId: "2", data: product }) },
    targets: {
      getById: vi.fn().mockResolvedValue({
        id: "10", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress", enabled: false,
        config: { requiredReferenceTypes: ["brand"], sizeMappings: [{ sourceValue: "7", taxonomy: "pa_razmer", termId: 107 }] },
      }),
      findTargetProduct: vi.fn().mockResolvedValue(targetId === 0 ? null : { externalId: String(targetId) }),
      findProductSnapshot: vi.fn().mockResolvedValue(targetId === 0 ? null : {
        fetchedAt: "2026-08-06T00:00:00.000Z",
        payload: { product: {
          title: "Old title", slug: "test-shoe", sku: "SKU-2",
          description_html: "<p>Old</p>", short_description_html: "",
          images: [{ attachment_id: 55, url: "https://shop.example/wp-content/uploads/old.webp", position: 0, featured: true }],
          taxonomies: {}, variations: [],
        } },
      }),
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
  return { service: new WordPressPreviewService(repositories as never, exporters, mappings as never), request, repositories };
}

describe("WordPressPreviewService", () => {
  it("builds a read-only preview for an existing WordPress product", async () => {
    const { service, request } = setup(321, "source_identity");

    await expect(service.preview("2", "10")).resolves.toMatchObject({
      externalId: "321",
      willCreate: false,
      matchedBy: "source_identity",
      target: { id: "10", enabled: false },
      payload: { fields: { title: "Test shoe", sku: "SKU-2" } },
      diff: {
        fields: expect.arrayContaining([
          expect.objectContaining({ field: "title" }),
          expect.objectContaining({ field: "description_html" }),
        ]),
        images: { changed: true, differences: [expect.objectContaining({ position: 0 })] },
      },
    });
    expect(String(request.mock.calls[0]?.[0])).toContain("slds_target_import_api=upsert-lookup");
    expect(String(request.mock.calls[0]?.[0])).not.toContain("upsert-jobs");
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
});
