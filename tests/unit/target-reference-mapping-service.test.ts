import { describe, expect, it, vi } from "vitest";

import { MappingMissingError } from "../../src/core/errors/index.js";
import type { ReferenceRepository, TargetValueMappingRecord } from "../../src/repositories/index.js";
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
});
