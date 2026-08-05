import { describe, expect, it, vi } from "vitest";

import type { TargetDictionaryProvider } from "../../src/integrations/index.js";
import { TargetDictionaryProviderRegistry } from "../../src/integrations/index.js";
import type { ProductAdminReadModel, ProductAdminRepository } from "../../src/repositories/index.js";
import { ProductAdminService } from "../../src/services/index.js";

function snapshot(): ProductAdminReadModel {
  const now = "2026-08-02T00:00:00.000Z";
  return {
    source: { id: "1", code: "test", name: "Test source", adapterCode: "test", config: {}, enabled: true, createdAt: now, updatedAt: now },
    sourceProduct: {
      id: "3", sourceId: "1", sourceKey: "source-3", externalId: "donor-3", slug: "shoe-3",
      url: "https://donor.example/shoe-3", discoveryMetadata: {}, status: "active",
      firstSeenAt: now, lastSeenAt: now, lastSeenRunId: null, createdAt: now, updatedAt: now,
    },
    lastCollectionRun: null,
    internalProduct: {
      id: "7", sourceProductId: "3", inputHash: "input", contentHash: "content", processorVersion: "2.1.0",
      status: "processed", processedAt: now, lastError: null, createdAt: now, updatedAt: now,
      data: {
        sourceProductId: "3", title: "Test shoe", description: "Description", sku: "SKU-3",
        images: [{
          url: "https://parser.example/images/3.webp", sourceUrl: "https://donor.example/3.jpg",
          localPath: "C:/private/3.jpg", webpLocalPath: "C:/private/3.webp",
          position: 0, alt: "Test shoe", attributes: {},
        }],
        variants: [], referenceCandidates: [], attributes: {}, metadata: {},
      },
    },
    parts: [], operations: [], classifications: [], jobs: [],
    targets: [{
      target: {
        id: "10", code: "shop", name: "Shop", exporterCode: "wordpress",
        config: {}, enabled: true, createdAt: now, updatedAt: now,
      },
      product: {
        id: "12", targetId: "10", internalProductId: "7", externalId: "99", status: "synced",
        lastExportedHash: "content", lastExportFingerprint: "fingerprint", lastAttemptAt: now,
        syncedAt: now, lastError: null, createdAt: now, updatedAt: now,
      },
    }],
  };
}

describe("ProductAdminService", () => {
  it("builds donor and target links without exposing local image paths", async () => {
    const repository: ProductAdminRepository = { getById: vi.fn().mockResolvedValue(snapshot()) };
    const provider: TargetDictionaryProvider = {
      code: "wordpress", supportedEntityTypes: [], creatableEntityTypes: [], classificationCapabilities: [],
      productEditUrl: (id) => `https://shop.example/wp-admin/post.php?post=${id}&action=edit`,
      fetchPage: vi.fn(), createTerm: vi.fn(),
    };
    const providers = new TargetDictionaryProviderRegistry();
    providers.register(provider);

    const result = await new ProductAdminService(repository, providers).getProduct("3");

    expect(result.sourceProduct.donorUrl).toBe("https://donor.example/shoe-3");
    expect(result.targets[0]?.editUrl).toBe("https://shop.example/wp-admin/post.php?post=99&action=edit");
    expect(result.product?.images[0]).not.toHaveProperty("localPath");
    expect(result.product?.images[0]).not.toHaveProperty("webpLocalPath");
    expect(result.processing.currentOutput?.title).toBe("Test shoe");
    expect(result.processing.currentOutput?.images[0]).not.toHaveProperty("localPath");
  });

  it("prioritizes an active export job over the stored target status", async () => {
    const value = snapshot();
    const target = value.targets[0]!;
    const observed = { ...target.product!, status: "observed" };
    const repository: ProductAdminRepository = {
      getById: vi.fn().mockResolvedValue({
        ...value,
        targets: [{ ...target, product: observed }],
        jobs: [{
          id: "50", jobType: "export_product", payload: { internalProductId: "7", targetId: "10", force: false },
          status: "retry", attempts: 1, availableAt: value.sourceProduct.updatedAt, lockedAt: null, lockedBy: null,
          uniqueKey: "export-7-10", lastError: "temporary", createdAt: value.sourceProduct.createdAt,
          updatedAt: value.sourceProduct.updatedAt, finishedAt: null,
        }],
      }),
    };

    const result = await new ProductAdminService(repository, new TargetDictionaryProviderRegistry()).getProduct("3");

    expect(result.targets[0]).toMatchObject({ status: "pending", activeExportStatus: "retry", externalId: "99" });
  });

  it("keeps the observed status when no export job is active", async () => {
    const value = snapshot();
    const target = value.targets[0]!;
    const repository: ProductAdminRepository = { getById: vi.fn().mockResolvedValue({ ...value, targets: [{ ...target, product: { ...target.product!, status: "observed" } }] }) };

    const result = await new ProductAdminService(repository, new TargetDictionaryProviderRegistry()).getProduct("3");

    expect(result.targets[0]).toMatchObject({ status: "observed", activeExportStatus: null });
  });

  it("exposes the canonical DTO separately from a historical classified attempt", async () => {
    const value = snapshot();
    const historical = { ...value.internalProduct!.data, title: "Old classified title" };
    const repository: ProductAdminRepository = {
      getById: vi.fn().mockResolvedValue({
        ...value,
        processingAttempts: [{
          attemptId: "attempt-1", sourceProductId: "3", processorVersion: "2.1.0", status: "completed",
          processorOutput: historical, operationsOutput: historical, classifiedOutput: historical,
          startedAt: value.sourceProduct.createdAt, finishedAt: value.sourceProduct.updatedAt, error: null,
        }],
      }),
    };

    const result = await new ProductAdminService(repository, new TargetDictionaryProviderRegistry()).getProduct("3");

    expect(result.processing.currentOutput?.title).toBe("Test shoe");
    expect(result.processing.attempts[0]?.classifiedOutput?.title).toBe("Old classified title");
  });
});
