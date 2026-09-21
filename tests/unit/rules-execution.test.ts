import { afterEach, describe, expect, it, vi } from "vitest";
import { RulesExecution } from "../../src/infrastructure/db/rules-execution.js";
import { RulesV2Runtime } from "../../src/infrastructure/db/rules-v2-runtime.js";
import { RulesV2Snapshot } from "../../src/services/rules-v2-snapshot.js";
import type { ClassificationRepository, ReferenceRepository, RuleV2Record } from "../../src/repositories/index.js";
import type { SqlPool, SqlExecutor, SqlResult } from "../../src/infrastructure/db/sql-executor.js";
import type { UniversalProductDTO } from "../../src/contracts/index.js";
import type { SupplementalTargetAssignmentResolver } from "../../src/services/target-reference-mapping-service.js";

const product: UniversalProductDTO = { sourceProductId: "1", title: "Samba", description: "", sku: "", images: [], variants: [], referenceCandidates: [], attributes: {}, metadata: {} };
function setup(titleBrandAssignments?: SupplementalTargetAssignmentResolver) {
  let mode: "v1" | "v2" = "v1";
  let revision = "1";
  const statements: string[] = [];
  const query: SqlExecutor["query"] = async <Row extends Record<string, unknown>>(sql: string): Promise<SqlResult<Row>> => {
    statements.push(sql);
    const rows = sql.includes("FROM rules_execution_control") ? [{ mode, revision }]
      : sql.includes("FROM target_export_revisions") ? [{ target_id: "10", revision: "19" }] : [];
    return { rows: rows as unknown as Row[], rowCount: rows.length };
  };
  const pool: SqlPool & SqlExecutor = { query, connect: async () => ({ query, release() {} }), async end() {} };
  const legacy: ClassificationRepository = { listReferenceTypes: async () => [], findSourceDecisions: async () => [],
    getActiveRuleSetRevision: async () => "old", listAllActiveRules: async () => [], listActiveRules: async () => [], saveProductResult: async () => {} };
  const references = { getTargetMappingRevision: async () => "17" } as unknown as ReferenceRepository;
  const load = vi.spyOn(RulesV2Runtime.prototype, "snapshot").mockResolvedValue(new RulesV2Snapshot("frozen", []));
  const execution = new RulesExecution(pool, legacy, titleBrandAssignments);
  return { execution, references, statements, load, switchMode: (next: "v1" | "v2", nextRevision: string) => { mode = next; revision = nextRevision; } };
}
afterEach(() => vi.restoreAllMocks());
describe("RulesExecution", () => {
  it("persists direct source selections without internal reference IDs", async () => {
    const { execution, switchMode, load } = setup();
    const rule: RuleV2Record = { id: "7", sourceId: "1", sourceCode: "goat", targetId: null, targetCode: null,
      name: "Nike", groupCode: "classification_exact", priority: 100, status: "shadow",
      conditionGroups: [{ conditions: [{ field: "candidate.brand.sourceValue", operator: "equals", values: ["Nike"] }] }],
      actions: [{ kind: "resolve_reference", referenceType: "brand", referenceValueId: "11", referenceValueCode: "nike",
        referenceValueName: "Nike", resolutionStatus: "confirmed" }],
      originKind: "exact_mapping", originId: "20", originRevision: "1",
      originPayload: { scope: "product.brand", normalizedSourceValue: "nike", contextKey: "{}" },
      revision: "1", createdAt: "2026-09-20", updatedAt: "2026-09-20" };
    load.mockResolvedValue(new RulesV2Snapshot("frozen", [rule], [{ code: "brand", cardinality: "single",
      allowedSubjectKinds: ["product"], metadata: {} }]));
    switchMode("v2", "2");
    const result = await execution.decideProduct({ id: "1", code: "goat", config: {} },
      { id: "1", sourceId: "1", sourceKey: "shoe", metadata: {} }, { ...product,
        referenceCandidates: [{ key: "product:brand", typeCode: "brand", scope: "product.brand",
          subjectKind: "product", sourceValue: "Nike", context: {}, evidence: {} }] });
    expect(result?.classification).toBeUndefined();
    expect(result?.rulesV2).toMatchObject({ status: "complete", selections: [
      { candidateKey: "product:brand", status: "resolved", sourceRuleId: "7" },
    ] });
    expect(JSON.stringify(result)).not.toContain("referenceValueId");
  });
  it("resolves v2 assignments without stored product classification", async () => {
    const resolveTitle = vi.fn().mockReturnValue([]);
    const title = { createTargetAssignmentResolver: vi.fn().mockResolvedValue(resolveTitle) };
    const { execution, switchMode } = setup(title);
    const source = { id: "1", code: "goat", config: {} };
    const sourceProduct = { id: "1", sourceId: "1", sourceKey: "shoe", metadata: {} };
    expect(await execution.resolveDirectAssignments("10", source, sourceProduct, product)).toBeNull();
    switchMode("v2", "2");
    expect(await execution.resolveDirectAssignments("10", source, sourceProduct, product)).toEqual([]);
    expect(resolveTitle).toHaveBeenCalledWith(product, false);
    expect(title.createTargetAssignmentResolver).toHaveBeenCalledTimes(1);
  });
  it("keeps v1 unchanged and switches processing and export preparation together", async () => {
    const { execution, switchMode, references } = setup();
    const old = await execution.classifier.classify("1", product);
    expect(old.product.classification.execution).toBeUndefined();
    expect(await execution.references(references).getTargetMappingRevision("10")).toBe("17");
    switchMode("v2", "2");
    const next = await execution.prepareProduct("1", old.product);
    expect(next.classification).toBeUndefined();
    expect(await execution.references(references).getTargetMappingRevision("10")).toBe("19");
    const storedV2 = (await execution.classifier.classify("1", old.product)).product;
    switchMode("v1", "3");
    expect(await execution.prepareProduct("1", storedV2)).toEqual(old.product);
    const directProduct = { ...next, rulesV2: { revision: "2", fingerprint: "direct",
      status: "complete" as const, selections: [] } };
    expect(await execution.prepareProduct("1", directProduct)).toEqual(old.product);
  });
  it("pins a snapshot through concurrent mode changes and refreshes on the next operation", async () => {
    const { execution, switchMode, load } = setup();
    switchMode("v2", "2");
    await execution.run(async () => {
      expect((await execution.prepareProduct("1", product)).classification).toBeUndefined();
      switchMode("v1", "3");
      expect((await execution.prepareProduct("1", product)).classification).toBeUndefined();
    });
    expect(new Set(load.mock.contexts).size).toBe(1);
    expect((await execution.classifier.classify("1", product)).product.classification.execution).toBeUndefined();
  });
  it("reuses compiled snapshots and rejects missing control instead of falling back", async () => {
    const { execution, switchMode, load } = setup();
    switchMode("v2", "2");
    await execution.classifier.classify("1", product);
    await execution.classifier.classify("1", product);
    expect(new Set(load.mock.contexts).size).toBe(2);
    switchMode("v2", "3");
    await execution.classifier.classify("1", product);
    expect(new Set(load.mock.contexts).size).toBe(4);
  });
  it("validates v2 candidates against the v2 type snapshot instead of legacy types", async () => {
    const { execution, switchMode, load } = setup();
    load.mockResolvedValue(new RulesV2Snapshot("frozen", [], [{ code: "brand", cardinality: "single",
      allowedSubjectKinds: ["product"], metadata: {} }]));
    switchMode("v2", "2");
    const run = await execution.classifier.classify("1", { ...product, referenceCandidates: [{
      key: "product:brand", typeCode: "brand", scope: "product.brand", subjectKind: "product",
      sourceValue: "Adidas", context: {}, evidence: {},
    }] });
    expect(run.product.classification.execution?.mode).toBe("v2");
    expect(run.product.classification.unresolved).toHaveLength(1);
  });
});
