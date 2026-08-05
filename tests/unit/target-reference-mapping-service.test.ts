import { describe, expect, it, vi } from "vitest";

import { MappingMissingError } from "../../src/core/errors/index.js";
import type { ReferenceRepository, TargetClassificationProjectionRecord, TargetValueMappingRecord } from "../../src/repositories/index.js";
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
      { resolutionKind: "mapping", resolutionId: "21" },
      { resolutionKind: "mapping", resolutionId: "21" },
    ])).resolves.toEqual([{
      resolutionKind: "mapping",
      resolutionId: "21",
      targetScope: "product.tag",
      externalValue: "892",
    }]);
    expect(repository.resolveTargetProjections).toHaveBeenCalledWith("2", [{ resolutionKind: "mapping", resolutionId: "21" }]);
  });
});
