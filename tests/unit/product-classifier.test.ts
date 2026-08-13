import { describe, expect, it, vi } from "vitest";

import type { ReferenceCandidateDTO, UniversalProductDTO } from "../../src/contracts/index.js";
import { IntegrationContractError } from "../../src/core/errors/index.js";
import { stableJsonStringify } from "../../src/core/utils/index.js";
import { ProductClassifier } from "../../src/services/index.js";
import { createMemoryRepositories, MemoryStore, validProduct } from "../support/in-memory.js";

function productWith(candidate: ReferenceCandidateDTO): UniversalProductDTO {
  return { ...validProduct(), referenceCandidates: [candidate] };
}

function modelCandidate(title: string, brand: string, family: string): ReferenceCandidateDTO {
  return {
    key: "product:model",
    typeCode: "model",
    scope: "product.model",
    subjectKind: "product",
    sourceValue: title,
    context: { brand, family },
    evidence: { title, brand, family },
  };
}

describe("ProductClassifier", () => {
  it("uses a confirmed source decision with normalized value and context", async () => {
    const store = new MemoryStore();
    store.classificationDecisions.set(`source-a/brand/product.brand/nike/${stableJsonStringify({})}`, {
      mappingId: "10",
      referenceValueId: "100",
      status: "confirmed",
      revision: "3",
    });
    const classifier = new ProductClassifier(createMemoryRepositories(store).classifications);
    const result = await classifier.classify("source-a", productWith({
      key: "product:brand",
      typeCode: "brand",
      scope: "product.brand",
      subjectKind: "product",
      sourceValue: " ＮＩＫＥ ",
      context: {},
      evidence: { title: "Nike Product" },
    }));

    expect(result.product.classification).toMatchObject({
      status: "complete",
      resolved: [{ candidateKey: "product:brand", referenceValueId: "100", resolutionKind: "mapping", resolutionId: "10", resolutionRevision: "3" }],
      unresolved: [],
    });
  });

  it("keeps source decisions isolated between different sources", async () => {
    const store = new MemoryStore();
    store.classificationDecisions.set("goat/brand/product.brand/nike/{}", { mappingId: "10", referenceValueId: "100", status: "confirmed", revision: "1" });
    const classifier = new ProductClassifier(createMemoryRepositories(store).classifications);
    const candidate: ReferenceCandidateDTO = { key: "product:brand", typeCode: "brand", scope: "product.brand", subjectKind: "product", sourceValue: "Nike", context: {}, evidence: {} };

    await expect(classifier.classify("goat", productWith(candidate))).resolves.toMatchObject({ product: { classification: { status: "complete" } } });
    await expect(classifier.classify("another-source", productWith(candidate))).resolves.toMatchObject({ product: { classification: { status: "partial", unresolved: [{ reason: "mapping_missing" }] } } });
  });

  it("separates Pegasus models by contextual rules instead of mapping the family", async () => {
    const store = new MemoryStore();
    store.classificationRules.push(
      { id: "1", sourceId: "goat", typeCode: "model", name: "ACG Pegasus Trail", priority: 100, conditions: [
        { field: "evidence.brand", operator: "equals", value: "Nike" },
        { field: "evidence.family", operator: "equals", value: "Pegasus" },
        { field: "evidence.title", operator: "contains", value: "ACG Pegasus Trail" },
      ], referenceValueId: "model-acg", revision: "1" },
      { id: "2", sourceId: "goat", typeCode: "model", name: "Air Pegasus 2005", priority: 100, conditions: [
        { field: "evidence.brand", operator: "equals", value: "Nike" },
        { field: "evidence.family", operator: "equals", value: "Pegasus" },
        { field: "evidence.title", operator: "contains", value: "Air Pegasus 2005" },
      ], referenceValueId: "model-2005", revision: "1" },
    );
    const classifier = new ProductClassifier(createMemoryRepositories(store).classifications);

    const trail = await classifier.classify("goat", productWith(modelCandidate("Nike Wmns ACG Pegasus Trail 'Jade Horizon'", "Nike", "Pegasus")));
    const air = await classifier.classify("goat", productWith(modelCandidate("Nike Air Pegasus 2005 'White Black'", "Nike", "Pegasus")));

    expect(trail.product.classification.resolved[0]?.referenceValueId).toBe("model-acg");
    expect(air.product.classification.resolved[0]?.referenceValueId).toBe("model-2005");
  });

  it("loads and compiles the rule set once while its revision is unchanged", async () => {
    const store = new MemoryStore();
    store.classificationRules.push({ id: "1", sourceId: "goat", typeCode: "model", name: "Air Max 90", priority: 100, conditions: [
      { field: "context.brand", operator: "equals", value: "Nike" },
      { field: "context.family", operator: "equals", value: "Air Max 90" },
    ], referenceValueId: "air-max-90", revision: "1" });
    const repository = createMemoryRepositories(store).classifications;
    const load = vi.spyOn(repository, "listAllActiveRules");
    const classifier = new ProductClassifier(repository);

    await classifier.classify("goat", productWith(modelCandidate("Nike Air Max 90", "Nike", "Air Max 90")));
    await classifier.classify("goat", productWith(modelCandidate("Nike Air Max 90 Premium", "Nike", "Air Max 90")));

    expect(load).toHaveBeenCalledOnce();
  });

  it("shares the initial rule-set load between concurrent classifications", async () => {
    const store = new MemoryStore();
    store.classificationRules.push({ id: "1", sourceId: "goat", typeCode: "model", name: "Air Max 90", priority: 100, conditions: [
      { field: "context.brand", operator: "equals", value: "Nike" },
      { field: "context.family", operator: "equals", value: "Air Max 90" },
    ], referenceValueId: "air-max-90", revision: "1" });
    const repository = createMemoryRepositories(store).classifications;
    const load = vi.spyOn(repository, "listAllActiveRules");
    const classifier = new ProductClassifier(repository);

    await Promise.all(Array.from({ length: 10 }, (_, index) => classifier.classify(
      "goat",
      productWith(modelCandidate(`Nike Air Max 90 ${index}`, "Nike", "Air Max 90")),
    )));

    expect(load).toHaveBeenCalledOnce();
  });

  it("invalidates the compiled rule index when the rule-set revision changes", async () => {
    const store = new MemoryStore();
    const repository = createMemoryRepositories(store).classifications;
    const load = vi.spyOn(repository, "listAllActiveRules");
    const classifier = new ProductClassifier(repository);
    const candidate = productWith(modelCandidate("Nike Air Max 90", "Nike", "Air Max 90"));
    await classifier.classify("goat", candidate);
    store.classificationRules.push({ id: "1", sourceId: "goat", typeCode: "model", name: "Air Max 90", priority: 100, conditions: [
      { field: "context.brand", operator: "equals", value: "Nike" },
      { field: "context.family", operator: "equals", value: "Air Max 90" },
    ], referenceValueId: "air-max-90", revision: "1" });

    const result = await classifier.classify("goat", candidate);

    expect(load).toHaveBeenCalledTimes(2);
    expect(result.product.classification.resolved[0]?.referenceValueId).toBe("air-max-90");
  });

  it("separates Surge Golf and Surge 4 using contains and regex rules", async () => {
    const store = new MemoryStore();
    store.classificationRules.push(
      { id: "3", sourceId: "goat", typeCode: "model", name: "Surge Golf", priority: 100, conditions: [
        { field: "evidence.brand", operator: "equals", value: "Under Armour" },
        { field: "evidence.family", operator: "equals", value: "Surge" },
        { field: "evidence.title", operator: "contains", value: "Surge Golf" },
      ], referenceValueId: "model-golf", revision: "1" },
      { id: "4", sourceId: "goat", typeCode: "model", name: "Surge 4", priority: 100, conditions: [
        { field: "evidence.brand", operator: "equals", value: "Under Armour" },
        { field: "evidence.family", operator: "equals", value: "Surge" },
        { field: "evidence.title", operator: "regex", value: "\\bSurge\\s+4\\b" },
      ], referenceValueId: "model-4", revision: "1" },
    );
    const classifier = new ProductClassifier(createMemoryRepositories(store).classifications);

    const golf = await classifier.classify("goat", productWith(modelCandidate("Under Armour Wmns Surge Golf 'White Clay'", "Under Armour", "Surge")));
    const fourth = await classifier.classify("goat", productWith(modelCandidate("Under Armour Surge 4 GS 'Serpentine'", "Under Armour", "Surge")));

    expect(golf.product.classification.resolved[0]?.referenceValueId).toBe("model-golf");
    expect(fourth.product.classification.resolved[0]?.referenceValueId).toBe("model-4");
  });

  it("does not reuse an exact mapping between different titles with the same family", async () => {
    const store = new MemoryStore();
    store.classificationDecisions.set(
      `goat/model/product.model/under armour wmns surge golf 'white clay'/${stableJsonStringify({ brand: "Under Armour", family: "Surge" })}`,
      { mappingId: "10", referenceValueId: "model-golf", status: "confirmed", revision: "1" },
    );
    const classifier = new ProductClassifier(createMemoryRepositories(store).classifications);

    const golf = await classifier.classify("goat", productWith(modelCandidate("Under Armour Wmns Surge Golf 'White Clay'", "Under Armour", "Surge")));
    const fourth = await classifier.classify("goat", productWith(modelCandidate("Under Armour Surge 4 GS 'Serpentine'", "Under Armour", "Surge")));

    expect(golf.product.classification.resolved[0]?.referenceValueId).toBe("model-golf");
    expect(fourth.product.classification).toMatchObject({ status: "partial", unresolved: [{ sourceValue: "Under Armour Surge 4 GS 'Serpentine'" }] });
  });

  it("does not guess when equally specific rules point to different values", async () => {
    const store = new MemoryStore();
    store.classificationRules.push(
      { id: "5", sourceId: "goat", typeCode: "model", name: "First", priority: 10, conditions: [{ field: "evidence.family", operator: "equals", value: "Pegasus" }], referenceValueId: "first", revision: "1" },
      { id: "6", sourceId: "goat", typeCode: "model", name: "Second", priority: 10, conditions: [{ field: "evidence.family", operator: "equals", value: "Pegasus" }], referenceValueId: "second", revision: "1" },
    );
    const classifier = new ProductClassifier(createMemoryRepositories(store).classifications);
    const result = await classifier.classify("goat", productWith(modelCandidate("Nike Pegasus", "Nike", "Pegasus")));
    expect(result.product.classification).toMatchObject({ status: "partial", unresolved: [{ reason: "rule_ambiguous" }] });
    expect(result.observations[0]?.matchedRuleIds).toEqual(["5", "6"]);
  });

  it("preserves an explicit ignored decision without inventing a reference", async () => {
    const store = new MemoryStore();
    store.classificationDecisions.set("source-a/tag/product.tag/promo/{}", { mappingId: "20", referenceValueId: null, status: "ignored", revision: "2" });
    const classifier = new ProductClassifier(createMemoryRepositories(store).classifications);
    const result = await classifier.classify("source-a", productWith({ key: "product:tag:0", typeCode: "tag", scope: "product.tag", subjectKind: "product", sourceValue: "Promo", context: {}, evidence: {} }));
    expect(result.product.classification).toMatchObject({ status: "complete", resolved: [], ignored: [{ mappingId: "20", sourceValue: "Promo" }], unresolved: [] });
  });

  it("rejects an unregistered reference type instead of silently dropping it", async () => {
    const store = new MemoryStore();
    const classifier = new ProductClassifier(createMemoryRepositories(store).classifications);
    await expect(classifier.classify("source-a", productWith({ key: "product:unknown", typeCode: "unknown_type", scope: "product.unknown", subjectKind: "product", sourceValue: "Value", context: {}, evidence: {} }))).rejects.toBeInstanceOf(IntegrationContractError);
  });

  it("enforces configured subject and cardinality without hardcoded product fields", async () => {
    const store = new MemoryStore();
    const classifier = new ProductClassifier(createMemoryRepositories(store).classifications);
    const brand = (key: string, value: string): ReferenceCandidateDTO => ({ key, typeCode: "brand", scope: "product.brand", subjectKind: "product", sourceValue: value, context: {}, evidence: {} });
    await expect(classifier.classify("source-a", { ...validProduct(), referenceCandidates: [brand("brand:1", "Nike"), brand("brand:2", "Adidas")] })).rejects.toBeInstanceOf(IntegrationContractError);
    await expect(classifier.classify("source-a", productWith({ key: "variant:brand", typeCode: "brand", scope: "variant.brand", subjectKind: "variant", subjectKey: "variant-1", sourceValue: "Nike", context: {}, evidence: {} }))).rejects.toBeInstanceOf(IntegrationContractError);
  });
});
