import { describe, expect, it, vi } from "vitest";

import type { JsonObject, UniversalProductDTO } from "../../src/contracts/index.js";
import { WordPressTitleBrandAssignmentResolver } from "../../src/integrations/index.js";
import type { TargetDictionaryRepository, TargetDictionaryValueRecord, TargetRecord } from "../../src/repositories/index.js";

function dictionaryValue(
  id: string,
  entityType: string,
  externalId: string,
  name: string,
  metadata: JsonObject = {},
): TargetDictionaryValueRecord {
  return {
    id, targetId: "1", entityType, externalId, name, metadata,
    slug: null, parentExternalId: null, taxonomy: entityType === "brands" ? "pa_brand" : "product_tag",
    attributeCode: null, remoteUpdatedAt: null, syncCursor: null, active: true,
    firstSeenAt: "2026-08-17T00:00:00.000Z", lastSeenAt: "2026-08-17T00:00:00.000Z",
  };
}

function target(enabled = true): TargetRecord {
  return {
    id: "1", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress",
    config: enabled ? { assignTitleBrandMentions: true } : {}, enabled: false,
    createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

function product(title: string, resolvedBrand = true, primaryBrand = "Nike"): UniversalProductDTO {
  return {
    sourceProductId: "10", title, description: "", sku: "SKU", images: [], variants: [],
    referenceCandidates: [], attributes: { brand: primaryBrand }, metadata: {},
    classification: {
      status: "complete", classifierVersion: "1", fingerprint: "hash",
      resolved: resolvedBrand ? [{
        candidateKey: "product:brand", typeCode: "brand", scope: "product.brand", subjectKind: "product",
        referenceValueId: "20", resolutionKind: "mapping", resolutionId: "30", resolutionRevision: "1",
      }] : [],
      ignored: [], unresolved: [],
    },
  };
}

function repository(
  brands: readonly TargetDictionaryValueRecord[],
  tags: readonly TargetDictionaryValueRecord[],
  targetRecord: TargetRecord = target(),
): TargetDictionaryRepository {
  return {
    listTargets: vi.fn().mockResolvedValue([targetRecord]),
    listValues: vi.fn().mockResolvedValue(brands),
    listValuesByExternalIds: vi.fn().mockImplementation(async (_targetId, ids: readonly string[]) =>
      tags.filter((tag) => ids.includes(tag.externalId))),
  } as unknown as TargetDictionaryRepository;
}

describe("WordPressTitleBrandAssignmentResolver", () => {
  it("adds every exact brand mention and its active landing tag", async () => {
    const brands = [
      dictionaryValue("1", "brands", "100", "Marvel", { rawMeta: { tag_id: 200 } }),
      dictionaryValue("2", "brands", "101", "Nike"),
    ];
    const tags = [dictionaryValue("3", "tags", "200", "Marvel")];
    const resolve = await new WordPressTitleBrandAssignmentResolver(repository(brands, tags))
      .createTargetAssignmentResolver("1");

    expect(resolve(product("Marvel x Nike SB Dunk High"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetScope: "product.brand", externalValue: "100", externalLabel: "Marvel", mode: "add" }),
      expect.objectContaining({ targetScope: "product.tag", externalValue: "200", externalLabel: "Marvel", mode: "add" }),
      expect.objectContaining({ targetScope: "product.brand", externalValue: "101", externalLabel: "Nike", mode: "add" }),
    ]));
  });

  it("does not match a brand outside an explicit collaboration but accepts it in a collaboration segment", async () => {
    const brands = [dictionaryValue("1", "brands", "100", "ON")];
    const resolve = await new WordPressTitleBrandAssignmentResolver(repository(brands, []))
      .createTargetAssignmentResolver("1");

    expect(resolve(product("Nike Keep On Pushin"))).toEqual([]);
    expect(resolve(product("LOEWE x On Cloudtilt"))).toEqual([
      expect.objectContaining({ targetScope: "product.brand", externalValue: "100" }),
    ]);
  });

  it("does not treat a suffix of a longer collaborator or a colorway as a brand", async () => {
    const brands = [
      dictionaryValue("1", "brands", "100", "Market"),
      dictionaryValue("2", "brands", "101", "Chinatown Market"),
      dictionaryValue("3", "brands", "102", "Off-White"),
    ];
    const resolve = await new WordPressTitleBrandAssignmentResolver(repository(brands, []))
      .createTargetAssignmentResolver("1");

    expect(resolve(product("Dover Street Market x Nike Dunk Low"))).toEqual([]);
    expect(resolve(product("adidas Samba OG 'Off White'", true, "adidas"))).toEqual([]);
    expect(resolve(product("Chinatown Market x Nike Dunk Low"))).toEqual([
      expect.objectContaining({ externalValue: "101" }),
    ]);
    expect(resolve(product("Off-White x Nike Air Force 1"))).toEqual([
      expect.objectContaining({ externalValue: "102" }),
    ]);
  });

  it("recognizes an additional brand beside the primary brand in the same collaboration segment", async () => {
    const brands = [dictionaryValue("1", "brands", "100", "NFL")];
    const resolve = await new WordPressTitleBrandAssignmentResolver(repository(brands, []))
      .createTargetAssignmentResolver("1");

    expect(resolve(product("Nike NFL x Train Speed 4 AMP"))).toEqual([
      expect.objectContaining({ externalValue: "100" }),
    ]);
  });

  it("chooses the longest brand when the final collaboration segment has overlapping names", async () => {
    const brands = [
      dictionaryValue("1", "brands", "100", "Clarks"),
      dictionaryValue("2", "brands", "101", "Clarks Originals"),
    ];
    const resolve = await new WordPressTitleBrandAssignmentResolver(repository(brands, []))
      .createTargetAssignmentResolver("1");

    expect(resolve(product("Supreme x Clarks Originals Wallabee", true, "Clarks Originals"))).toEqual([
      expect.objectContaining({ externalValue: "101" }),
    ]);
  });

  it("selects the only duplicate carrying a landing tag and skips unresolved ambiguity", async () => {
    const brands = [
      dictionaryValue("1", "brands", "100", "Sporty & Rich", { rawMeta: { tag_id: 300 } }),
      dictionaryValue("2", "brands", "101", "Sporty & Rich"),
      dictionaryValue("3", "brands", "102", "GRAF&WU"),
      dictionaryValue("4", "brands", "103", "GRAF&WU"),
    ];
    const tags = [dictionaryValue("5", "tags", "300", "Sporty & Rich")];
    const resolve = await new WordPressTitleBrandAssignmentResolver(repository(brands, tags))
      .createTargetAssignmentResolver("1");

    const assignments = resolve(product("Sporty & Rich x adidas GRAF&WU"));
    expect(assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetScope: "product.brand", externalValue: "100" }),
      expect.objectContaining({ targetScope: "product.tag", externalValue: "300" }),
    ]));
    expect(assignments.some((assignment) => ["101", "102", "103"].includes(assignment.externalValue))).toBe(false);
  });

  it("requires a resolved primary brand and an enabled target policy", async () => {
    const brands = [dictionaryValue("1", "brands", "100", "Marvel")];
    const active = await new WordPressTitleBrandAssignmentResolver(repository(brands, []))
      .createTargetAssignmentResolver("1");
    const disabledRepository = repository(brands, [], target(false));
    const disabled = await new WordPressTitleBrandAssignmentResolver(disabledRepository)
      .createTargetAssignmentResolver("1");

    expect(active(product("Marvel x Air Jordan", false))).toEqual([]);
    expect(disabled(product("Marvel x Air Jordan"))).toEqual([]);
    expect(disabledRepository.listValues).not.toHaveBeenCalled();
  });
});
