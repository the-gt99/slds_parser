import { describe, expect, it } from "vitest";

import type { ClassifiedReferenceDTO, UniversalProductDTO } from "../../src/contracts/index.js";
import { WordPressExportPolicy } from "../../src/integrations/index.js";
import { validProduct } from "../support/in-memory.js";

function resolved(candidateKey: string, typeCode: string): ClassifiedReferenceDTO {
  return {
    candidateKey,
    typeCode,
    scope: `product.${typeCode}`,
    subjectKind: "product",
    referenceValueId: `reference-${candidateKey}`,
    resolutionKind: "mapping",
    resolutionId: `mapping-${candidateKey}`,
    resolutionRevision: "1",
  };
}

function product(input: { readonly family?: string; readonly resolved?: readonly ClassifiedReferenceDTO[] }): UniversalProductDTO {
  return {
    ...validProduct(),
    attributes: input.family === undefined ? {} : { family: input.family },
    classification: {
      status: "partial",
      classifierVersion: "1",
      fingerprint: "fingerprint",
      resolved: input.resolved ?? [],
      ignored: [],
      unresolved: [],
    },
  };
}

describe("WordPressExportPolicy", () => {
  const policy = new WordPressExportPolicy();

  it("allows optional unresolved fields after brand and category are resolved", () => {
    const result = policy.evaluate(product({ resolved: [
      resolved("product:brand", "brand"),
      resolved("product:category", "category"),
    ] }));

    expect(result).toEqual({ ready: true, missingRequiredCandidateKeys: [] });
  });

  it("requires a model when GOAT provides a family", () => {
    const result = policy.evaluate(product({ family: "Air Zoom Pegasus 41", resolved: [
      resolved("product:brand", "brand"),
      resolved("product:category", "category"),
    ] }));

    expect(result).toEqual({ ready: false, missingRequiredCandidateKeys: ["product:model"] });
  });

  it("requires brand and category even when the universal candidate list is empty", () => {
    expect(policy.evaluate(product({}))).toEqual({
      ready: false,
      missingRequiredCandidateKeys: ["product:brand", "product:category"],
    });
  });
});
