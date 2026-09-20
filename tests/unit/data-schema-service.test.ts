import { describe, expect, it, vi } from "vitest";

import type { SourceRepository } from "../../src/repositories/index.js";
import { DataSchemaService } from "../../src/services/index.js";

describe("DataSchemaService", () => {
  it("separates the common contract from legacy rule paths", async () => {
    const sources = { listEnabled: vi.fn().mockResolvedValue([]) } as unknown as SourceRepository;
    const catalog = await new DataSchemaService(sources).catalog();
    const paths = catalog.common.fields.map((field) => field.path);

    expect(paths).toContain("characteristics.category");
    expect(paths).not.toContain("referenceCandidates.*.sourceValue");
    expect(paths).not.toContain("attributes.productType");
    expect(catalog.legacy.fields.map((field) => field.path)).toContain("referenceCandidates.*.sourceValue");
    expect(catalog.ruleFields.map((field) => field.path)).toContain("candidate.{type}.sourceValue");
  });
});
