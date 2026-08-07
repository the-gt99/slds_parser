import { describe, expect, it, vi } from "vitest";

import type { TargetDictionaryProvider } from "../../src/integrations/index.js";
import { TargetDictionaryProviderRegistry } from "../../src/integrations/index.js";
import type { JobRecord, JobRepository, ProductAdminReadModel, ProductAdminRepository } from "../../src/repositories/index.js";
import { ProductAdminService, type ProductClassifier } from "../../src/services/index.js";

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

  it("shows a saved classification decision while product reprocessing is pending", async () => {
    const value = snapshot();
    const repository: ProductAdminRepository = {
      getById: vi.fn().mockResolvedValue({
        ...value,
        classifications: [{
          id: "70", candidateKey: "product:category", typeCode: "category", typeName: "Категория",
          scope: "product.category", sourceValue: "sneakers", normalizedSourceValue: "sneakers",
          contextKey: "{}", context: {}, evidence: {}, status: "unresolved", issueReason: "mapping_missing",
          resolvedReferenceValueId: null, resolvedReferenceName: null, resolutionKind: null, resolutionId: null,
          outputs: [], firstSeenAt: value.sourceProduct.createdAt, lastSeenAt: value.sourceProduct.updatedAt,
        }],
        jobs: [{
          id: "80", jobType: "process_product", payload: { sourceProductId: "3", force: true }, status: "pending",
          attempts: 0, availableAt: value.sourceProduct.updatedAt, lockedAt: null, lockedBy: null,
          uniqueKey: "source-product:3:process", lastError: null, createdAt: value.sourceProduct.createdAt,
          updatedAt: value.sourceProduct.updatedAt, finishedAt: null,
        }],
      }),
    };
    const classifier = {
      classify: vi.fn().mockResolvedValue({
        product: value.internalProduct!.data,
        observations: [{
          candidate: { key: "product:category" }, status: "resolved", resolutionKind: "mapping", resolutionId: "147",
        }],
      }),
    } as unknown as ProductClassifier;

    const result = await new ProductAdminService(
      repository, new TargetDictionaryProviderRegistry(), undefined, undefined, classifier,
    ).getProduct("3");

    expect(result.classification.observations[0]?.pendingResolution).toEqual({
      status: "resolved", resolutionKind: "mapping", resolutionId: "147",
    });
  });

  it("previews product batch actions with deduplication and a server limit", async () => {
    const repository: ProductAdminRepository = {
      getById: vi.fn(),
      listBatchCandidates: vi.fn().mockResolvedValue({
        total: 2,
        items: [
          { sourceProductId: "1", internalProductId: null, stage: "discovered", imageCount: 0, activeCollectJobId: null, activeProcessJobId: null, failedProcessJobId: null },
          { sourceProductId: "2", internalProductId: null, stage: "discovered", imageCount: 0, activeCollectJobId: "9", activeProcessJobId: null, failedProcessJobId: null },
        ],
      }),
    };

    const result = await new ProductAdminService(repository, new TargetDictionaryProviderRegistry()).previewBatch({
      action: "collect",
      filter: { limit: 2 },
    });

    expect(result.selectedCount).toBe(2);
    expect(result.eligibleCount).toBe(1);
    expect(result.activeDuplicateCount).toBe(1);
    expect(result.jobsToCreate).toBe(1);
    expect(result.skipReasons).toEqual([{ reason: "Уже есть активная задача сбора", count: 1 }]);
  });

  it("applies batch actions through JobRepository and stores audit", async () => {
    const now = "2026-08-07T00:00:00.000Z";
    const repository: ProductAdminRepository = {
      getById: vi.fn(),
      listBatchCandidates: vi.fn().mockResolvedValue({
        total: 1,
        items: [{ sourceProductId: "5", internalProductId: "7", stage: "classified", imageCount: 2, activeCollectJobId: null, activeProcessJobId: null, failedProcessJobId: null }],
      }),
      saveBatchAudit: vi.fn().mockResolvedValue("11"),
    };
    const jobs: JobRepository = {
      enqueue: vi.fn().mockResolvedValue({
        id: "10", jobType: "process_product", payload: { sourceProductId: "5", force: true }, status: "pending",
        attempts: 0, availableAt: now, lockedAt: null, lockedBy: null, uniqueKey: "source-product:5:process",
        lastError: null, createdAt: now, updatedAt: now, finishedAt: null,
      } satisfies JobRecord),
      claimNext: vi.fn(), claimById: vi.fn(), complete: vi.fn(), retry: vi.fn(), fail: vi.fn(),
    };

    const result = await new ProductAdminService(repository, new TargetDictionaryProviderRegistry(), undefined, jobs).applyBatch({
      action: "reprocess",
      filter: { selectedIds: ["5"], limit: 100 },
    }, "admin");

    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      jobType: "process_product",
      payload: { sourceProductId: "5", force: true },
      uniqueKey: "source-product:5:process",
    }));
    expect(repository.saveBatchAudit).toHaveBeenCalledWith(expect.objectContaining({ actor: "admin", createdJobIds: ["10"] }));
    expect(result.auditId).toBe("11");
  });

  it("blocks mass export actions", async () => {
    const repository: ProductAdminRepository = { getById: vi.fn() };
    await expect(new ProductAdminService(repository, new TargetDictionaryProviderRegistry()).previewBatch({
      action: "export",
      filter: { limit: 1 },
    })).rejects.toThrow("Mass export is intentionally disabled");
  });

  it("retries only non-export failed jobs and records audit", async () => {
    const repository: ProductAdminRepository = {
      getById: vi.fn(),
      previewFailedJobRetry: vi.fn().mockResolvedValue({ jobType: "process_product", failedCount: 2, limitedCount: 2, activeDuplicateCount: 0, retryCount: 2, sampleJobIds: ["1", "2"] }),
      listFailedJobRetryIds: vi.fn().mockResolvedValue(["1", "2"]),
      saveBatchAudit: vi.fn().mockResolvedValue("20"),
    };
    const jobs: JobRepository = { enqueue: vi.fn(), claimNext: vi.fn(), claimById: vi.fn(), complete: vi.fn(), retry: vi.fn(), fail: vi.fn() };

    const result = await new ProductAdminService(repository, new TargetDictionaryProviderRegistry(), undefined, jobs).retryFailedJobs("process_product", 100, "admin", "retry");

    expect(jobs.retry).toHaveBeenCalledTimes(2);
    expect(repository.saveBatchAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "retry_failed_processing", actor: "admin", reason: "retry" }));
    expect(result.auditId).toBe("20");
    await expect(new ProductAdminService(repository, new TargetDictionaryProviderRegistry(), undefined, jobs).retryFailedJobs("export_product", 1, "admin")).rejects.toThrow("Export retry is disabled");
  });

  it("redacts secrets from job payloads", async () => {
    const repository: ProductAdminRepository = {
      getById: vi.fn(),
      listJobs: vi.fn().mockResolvedValue({
        total: 1,
        items: [{ id: "1", jobType: "collect_product", status: "failed", attempts: 1, createdAt: "now", availableAt: "now", lockedAt: null, lockedBy: null, updatedAt: "now", finishedAt: null, durationMs: null, sourceProductId: "2", lastError: "x", payload: { token: "secret", nested: { password: "secret" }, sourceProductId: "2" } }],
        summary: { byStatus: [], byTypeStatus: [], errorGroups: [], completion: { last15m: 0, last1h: 0, last24h: 0 }, etaMinutes: null },
      }),
    };

    const result = await new ProductAdminService(repository, new TargetDictionaryProviderRegistry()).listJobs({ limit: 50, offset: 0 });

    expect(JSON.stringify(result.items[0]?.payload)).not.toContain("secret");
    expect(result.items[0]?.payload).toEqual({ token: "[hidden]", nested: { password: "[hidden]" }, sourceProductId: "2" });
  });
});
