import { describe, expect, it, vi } from "vitest";

import { MappingMissingError } from "../../src/core/errors/index.js";
import type { ReferenceRepository, TargetClassificationProjectionRecord, TargetReferenceProjectionRecord, TargetValueMappingRecord } from "../../src/repositories/index.js";
import { TargetReferenceMappingService } from "../../src/services/index.js";

const targetMapping: TargetValueMappingRecord = {
  id: "201",
  targetId: "2",
  referenceValueId: "101",
  targetScope: "catalog",
  externalValue: "NIKE-EXT",
  externalLabel: "Nike",
  metadata: {},
};

function createRepository(targetResult: TargetValueMappingRecord | null = targetMapping): ReferenceRepository {
  return {
    resolveTargetValue: vi.fn().mockResolvedValue(targetResult),
    resolveTargetProjections: vi.fn().mockResolvedValue([]),
    saveTargetProjection: vi.fn(),
    getTargetMappingRevision: vi.fn().mockResolvedValue("revision-1"),
    listTargetAssignmentRules: vi.fn().mockResolvedValue([]),
  };
}

describe("TargetReferenceMappingService", () => {
  it("resolves a target mapping", async () => {
    const service = new TargetReferenceMappingService(createRepository());
    await expect(service.resolveTargetValue("2", "101", "catalog")).resolves.toBe("NIKE-EXT");
  });

  it("throws MappingMissingError for a missing target mapping", async () => {
    const service = new TargetReferenceMappingService(createRepository(null));
    await expect(service.resolveTargetValue("2", "999", "catalog")).rejects.toBeInstanceOf(MappingMissingError);
  });

  it("deduplicates resolution keys and returns target projections", async () => {
    const repository = createRepository();
    const projection: TargetClassificationProjectionRecord = {
      id: "301",
      targetId: "2",
      resolutionKind: "mapping",
      resolutionId: "21",
      targetScope: "product.tag",
      dictionaryValueId: "401",
      externalValue: "892",
      externalLabel: "Lifestyle",
      metadata: {},
      revision: "1",
    };
    vi.mocked(repository.resolveTargetProjections).mockResolvedValue([projection]);
    const service = new TargetReferenceMappingService(repository);

    await expect(service.resolveTargetProjections("2", [
      { resolutionKind: "mapping", resolutionId: "21", referenceId: "31" },
      { resolutionKind: "mapping", resolutionId: "21", referenceId: "31" },
    ])).resolves.toEqual([{
      resolutionKind: "mapping",
      resolutionId: "21",
      targetScope: "product.tag",
      externalValue: "892",
    }]);
    expect(repository.resolveTargetProjections).toHaveBeenCalledWith("2", [{ resolutionKind: "mapping", resolutionId: "21", referenceId: "31" }]);
  });

  it("returns canonical assignments from an internal value", async () => {
    const repository = createRepository();
    const projection: TargetReferenceProjectionRecord = {
      id: "302", targetId: "2", referenceValueId: "31", targetScope: "product.tag",
      dictionaryValueId: "402", externalValue: "895", externalLabel: "Для баскетбола",
      metadata: {}, revision: "1",
    };
    vi.mocked(repository.resolveTargetProjections).mockResolvedValue([projection]);
    const service = new TargetReferenceMappingService(repository);

    await expect(service.resolveTargetProjections("2", [
      { resolutionKind: "rule", resolutionId: "22", referenceId: "31" },
    ])).resolves.toEqual([{
      resolutionKind: "reference", resolutionId: "31", targetScope: "product.tag", externalValue: "895",
    }]);
  });

  it("keeps the origin of an automatically related target term", async () => {
    const repository = createRepository();
    const projection: TargetReferenceProjectionRecord = {
      id: "303", targetId: "2", referenceValueId: "31", targetScope: "product.tag",
      dictionaryValueId: "403", externalValue: "2968", externalLabel: "Onitsuka Tiger",
      metadata: {
        managedBy: "target_term_relation", relationCode: "landing",
        sourceTypeCode: "brand", sourceLabel: "Onitsuka Tiger",
      },
      revision: "1",
    };
    vi.mocked(repository.resolveTargetProjections).mockResolvedValue([projection]);

    await expect(new TargetReferenceMappingService(repository).resolveTargetProjections("2", [
      { resolutionKind: "mapping", resolutionId: "21", referenceId: "31" },
    ])).resolves.toEqual([expect.objectContaining({
      externalValue: "2968",
      provenance: {
        kind: "related_target_term", relationCode: "landing",
        sourceTypeCode: "brand", sourceLabel: "Onitsuka Tiger",
      },
    })]);
  });
});
