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
  });
});
