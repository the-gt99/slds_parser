import { describe, expect, it, vi } from "vitest";

import { MappingMissingError } from "../../src/core/errors/index.js";
import type {
  ReferenceRepository,
  ReferenceValueRecord,
  TargetValueMappingRecord,
} from "../../src/repositories/index.js";
import {
  normalizeSourceValue,
  ReferenceMappingService,
} from "../../src/services/index.js";

const referenceValue: ReferenceValueRecord = {
  id: "101",
  typeId: "11",
  code: "nike",
  name: "Nike",
  parentId: null,
  metadata: {},
  enabled: true,
};

const targetMapping: TargetValueMappingRecord = {
  id: "201",
  targetId: "2",
  referenceValueId: "101",
  targetScope: "catalog",
  externalValue: "NIKE-EXT",
  externalLabel: "Nike",
  metadata: {},
};

function createRepository(
  sourceResult: ReferenceValueRecord | null = referenceValue,
  targetResult: TargetValueMappingRecord | null = targetMapping,
): ReferenceRepository {
  return {
    resolveSourceValue: vi.fn().mockResolvedValue(sourceResult),
    resolveTargetValue: vi.fn().mockResolvedValue(targetResult),
    getTargetMappingRevision: vi.fn().mockResolvedValue("revision-1"),
  };
}

describe("normalizeSourceValue", () => {
  it("trims, applies NFKC and converts to lowercase", () => {
    expect(normalizeSourceValue("  ＮＩＫＥ  ")).toBe("nike");
  });
});

describe("ReferenceMappingService", () => {
  it("resolves a confirmed source mapping using the normalized value", async () => {
    const repository = createRepository();
    const service = new ReferenceMappingService(repository);

    await expect(
      service.resolveSourceValue("1", "brand", "catalog", "  ＮＩＫＥ "),
    ).resolves.toBe("101");
    expect(repository.resolveSourceValue).toHaveBeenCalledWith({
      sourceId: "1",
      typeCode: "brand",
      scope: "catalog",
      normalizedSourceValue: "nike",
      status: "confirmed",
    });
  });

  it("resolves a target mapping", async () => {
    const repository = createRepository();
    const service = new ReferenceMappingService(repository);

    await expect(
      service.resolveTargetValue("2", "101", "catalog"),
    ).resolves.toBe("NIKE-EXT");
  });

  it("throws MappingMissingError instead of guessing a missing mapping", async () => {
    const service = new ReferenceMappingService(createRepository(null, null));

    await expect(
      service.resolveSourceValue("1", "brand", "catalog", "Unknown"),
    ).rejects.toBeInstanceOf(MappingMissingError);
    await expect(
      service.resolveTargetValue("2", "999", "catalog"),
    ).rejects.toBeInstanceOf(MappingMissingError);
  });
});
