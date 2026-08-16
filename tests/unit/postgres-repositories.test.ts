import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  PostgresClassificationRepository,
  PostgresClassificationAdminRepository,
  PostgresExportControlRepository,
  PostgresJobRepository,
  PostgresProductAdminRepository,
  PostgresReferenceRepository,
  PostgresRuntimeWorkerSettingsRepository,
  PostgresSourceProductRepository,
  PostgresSourceRepository,
  PostgresSourceRunRepository,
  PostgresTargetContentTemplateRepository,
  PostgresTargetDictionaryRepository,
  PostgresTargetAssignmentRuleRepository,
  PostgresTargetRepository,
  PostgresWordPressCatalogRepository,
  DatabaseRetentionService,
} from "../../src/infrastructure/db/index.js";
import type { SqlExecutor, SqlPool, SqlResult } from "../../src/infrastructure/db/index.js";

interface Call { readonly text: string; readonly values: readonly unknown[] }

class FakeExecutor implements SqlExecutor {
  readonly calls: Call[] = [];
  constructor(private readonly results: QueryResultRow[][]) {}
  async query<Row extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<SqlResult<Row>> {
    const parameterNumbers = [...text.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]));
    const expectedValueCount = parameterNumbers.length === 0 ? 0 : Math.max(...parameterNumbers);
    if (values.length !== expectedValueCount) {
      throw new Error(`SQL expects ${expectedValueCount} parameters but received ${values.length}`);
    }
    this.calls.push({ text, values });
    const rows = this.results.shift() ?? [];
    return { rows: rows as Row[], rowCount: rows.length };
  }
}

function pool(executor: FakeExecutor): SqlPool {
  return { connect: async () => ({ query: executor.query.bind(executor), release: () => {} }), end: async () => {} };
}

const sourceRow = {
  id: "9007199254740993", code: "supplier", name: "Supplier", adapter_code: "adapter",
  config: { pageSize: 10 }, enabled: true,
  created_at: new Date("2026-01-02T03:04:05.000Z"), updated_at: "2026-01-03T03:04:05.000Z",
};

const partRow = {
  id: "11", source_product_id: "10", part_key: "details", raw_payload: { raw: true },
  parsed_payload: { parsed: true }, content_hash: "hash", source_updated_at: null,
  fetched_at: new Date("2026-02-01T00:00:00.000Z"), adapter_version: "1", created_at: new Date("2026-02-01T00:00:00.000Z"), updated_at: new Date("2026-02-01T00:00:00.000Z"),
};

const jobRow = {
  id: "21", job_type: "collect_product", payload: { id: 1 }, status: "running", attempts: 2,
  available_at: new Date("2026-03-01T00:00:00.000Z"), locked_at: new Date("2026-03-01T00:01:00.000Z"), locked_by: "worker", unique_key: "product-1", last_error: null,
  created_at: new Date("2026-03-01T00:00:00.000Z"), updated_at: new Date("2026-03-01T00:01:00.000Z"), finished_at: null,
};

const targetProductRow = {
  id: "31", target_id: "1", internal_product_id: "2", external_id: "external", status: "failed",
  last_exported_hash: "old-hash", last_export_fingerprint: "old-fingerprint", last_attempt_at: new Date("2026-04-01T00:00:00.000Z"), synced_at: new Date("2026-03-01T00:00:00.000Z"), last_error: "failure",
  created_at: new Date("2026-01-01T00:00:00.000Z"), updated_at: new Date("2026-04-01T00:00:00.000Z"),
};

const targetSnapshotRow = {
  id: "41", target_id: "1", source_product_id: "2", external_id: "321", source_external_id: "100",
  payload: { product: { target_id: 321 } }, content_hash: "snapshot-hash",
  fetched_at: new Date("2026-04-02T00:00:00.000Z"), created_at: new Date("2026-04-02T00:00:00.000Z"), updated_at: new Date("2026-04-02T00:00:00.000Z"),
};

const contentTemplateRow = {
  id: "51", target_id: "10", field_code: "description", name: "Описание",
  template_source: "<p>{{ product.sku }}</p>", profile_key: "default", profile_name: "Основной профиль",
  management_mode: "manage", category_term_ids: [74, 75], required_context_paths: ["content.story"], preserve_existing_story: true, status: "draft", revision: 2, actor: "admin",
  created_at: new Date("2026-08-09T00:00:00.000Z"), activated_at: null,
};

describe("PostgreSQL repository mapping and SQL", () => {
  it("matches target assignment source facts directly and treats missing facts as non-matches", async () => {
    const executor = new FakeExecutor([[{ product_count: 1, examples: [{ sourceProductId: "13791", title: "Obsidian", sku: "921948 400" }] }]]);
    const repository = new PostgresTargetAssignmentRuleRepository(pool(executor));

    const result = await repository.preview({
      targetId: "1", name: "Designer", groupCode: "designer_tag", priority: 100,
      conditions: [{ field: "product.fact.designer", operator: "equals", values: ["Wilson Smith"] }],
      actions: [{ targetScope: "product.tag", dictionaryValueId: "10", mode: "add" }],
    });

    expect(result.productCount).toBe(1);
    expect(executor.calls[0]?.text).toContain("COALESCE(internal.data#>>ARRAY");
    expect(executor.calls[0]?.text).not.toContain("JSONB_ARRAY_ELEMENTS($1::JSONB)");
    expect(executor.calls[0]?.values).toEqual([["wilson smith"], "sourceFacts", "designer"]);
  });

  it("previews target assignment model phrases with token boundaries", async () => {
    const executor = new FakeExecutor([[{ product_count: 1, examples: [] }]]);
    const repository = new PostgresTargetAssignmentRuleRepository(pool(executor));

    await repository.preview({
      targetId: "1", name: "Сабо", groupCode: "shoe_leaf_category", priority: 300,
      conditions: [{ field: "candidate.model.sourceValue", operator: "contains_phrase", values: ["UGG Tazz", "Birkenstock Tokio"] }],
      actions: [{ targetScope: "product.category", dictionaryValueId: "10", mode: "replace" }],
    });

    expect(executor.calls[0]?.text).toContain("REGEXP_REPLACE");
    expect(executor.calls[0]?.text).toContain("LIKE ANY");
    expect(executor.calls[0]?.values).toEqual([["% ugg tazz %", "% birkenstock tokio %"], "model"]);
  });

  it("pages the WordPress catalog through the compact read model and counts separately", async () => {
    const executor = new FakeExecutor([[], [{ total: "98632" }]]);
    const repository = new PostgresWordPressCatalogRepository(pool(executor));

    const result = await repository.listItems({
      runId: "1", search: "nike", auditStatus: "ready", risk: "danger",
      operation: "update", changeFlag: "taxonomy_removed:product_tag",
      variationFilter: "completed", limit: 40, offset: 80,
    });

    expect(result).toEqual({ items: [], total: 98632 });
    expect(executor.calls).toHaveLength(2);
    const page = executor.calls.find((call) => call.text.includes("WITH page AS MATERIALIZED"))!;
    const count = executor.calls.find((call) => call.text.includes("SELECT COUNT(*)::BIGINT AS total"))!;
    expect(page.text).toContain("wordpress_catalog_item_read_models");
    expect(page.text).not.toContain("COUNT(*) OVER()");
    expect(page.text).not.toContain("snapshot.payload");
    expect(page.text).toContain("model.change_flags @> ARRAY[");
    expect(count.values).not.toContain(40);
    expect(count.values).not.toContain(80);
  });

  it("returns locally stored proposed images with WordPress catalog item details", async () => {
    const executor = new FakeExecutor([[]]);
    const repository = new PostgresWordPressCatalogRepository(pool(executor));

    await repository.getItem("1", "247");

    expect(executor.calls[0]?.text).toContain("internal.data->'images'");
    expect(executor.calls[0]?.text).toContain("LEFT JOIN internal_products internal");
    expect(executor.calls[0]?.text).toContain("item.audit_result#>'{variations,items}'");
    expect(executor.calls[0]?.text).toContain("target.config->'sizeMappings'");
    expect(executor.calls[0]?.values).toEqual(["1", "247"]);
  });

  it("keeps source product id typed as bigint while building preflight search text", async () => {
    const executor = new FakeExecutor([[], [{ id: "31" }], [], []]);
    const repository = new PostgresExportControlRepository(pool(executor));

    await repository.savePreflight({
      targetId: "10",
      internalProductId: "31",
      sourceProductId: "21",
      sourceCode: "goat",
      sourceExternalId: "1001",
      title: "Nike Air Flight",
      imageUrl: null,
      status: "ready",
      phase: "ready",
      internalContentHash: "content-hash",
      configurationRevision: "1",
      payloadHash: "a".repeat(64),
      externalId: "41",
      willCreate: false,
      matchedBy: "source_identity",
      riskLevel: "none",
      changeFlags: [],
      fieldChangeCount: 0,
      taxonomyAddedCount: 0,
      taxonomyRemovedCount: 0,
      imageChangeCount: 0,
      variationChangeCount: 0,
      deactivatedVariationCount: 0,
      blockers: [],
      changeSummary: {},
      wordpressCheckedAt: "2026-08-12T10:00:00.000Z",
      wordpressStateHash: "b".repeat(64),
      usedCachedWordPress: false,
      preflightCache: {},
    });

    const saveCall = executor.calls[2]!;
    expect(saveCall.text).toContain("CONCAT_WS(' ', $3::BIGINT::TEXT, $5::TEXT, $6::TEXT)");
  });

  it("types a numeric export-control search once as bigint", async () => {
    const executor = new FakeExecutor([[], [{
      candidate_count: "120", reviewed_count: "100", unreviewed_count: "20",
      checking_count: "2", ready_count: "52", exportable_count: "51",
      blocked_count: "40", stale_count: "5", error_count: "1",
    }]]);
    const repository = new PostgresExportControlRepository(pool(executor));

    await repository.list({ targetId: "10", search: "7058", limit: 50 });

    const listCall = executor.calls[0]!;
    expect(listCall.text).toContain("review.source_product_id = $2::BIGINT");
    expect(listCall.text).toContain("review.source_external_id = $2::BIGINT::TEXT");
    expect(listCall.text).toContain("review.internal_content_hash <> internal.content_hash");
  });

  it("returns exact export readiness counters independently of the current page filter", async () => {
    const executor = new FakeExecutor([[], [{
      candidate_count: "12917", reviewed_count: "296", unreviewed_count: "12621",
      checking_count: "0", ready_count: "52", exportable_count: "51",
      blocked_count: "46", stale_count: "198", error_count: "0",
    }]]);
    const result = await new PostgresExportControlRepository(pool(executor)).list({ targetId: "10", status: "ready", limit: 50 });

    expect(result.summary).toEqual({
      candidateCount: 12917, reviewedCount: 296, unreviewedCount: 12621,
      checkingCount: 0, readyCount: 52, exportableCount: 51,
      blockedCount: 46, staleCount: 198, errorCount: 0,
    });
    expect(executor.calls[1]?.values).toEqual(["10"]);
    expect(executor.calls[1]?.text).toContain("data->'classification'->>'status' = 'complete'");
  });

  it("selects only existing stale reviews for automatic preflight maintenance", async () => {
    const executor = new FakeExecutor([[], [{ source_product_id: "21", internal_product_id: "31", refresh_wordpress: false }], [], []]);
    const result = await new PostgresExportControlRepository(pool(executor)).preparePreflightCandidates({ targetId: "10", mode: "stale", limit: 100 });

    const selectCall = executor.calls[1]!;
    expect(result).toEqual([{ sourceProductId: "21", internalProductId: "31", refreshWordPress: false }]);
    expect(selectCall.values).toEqual(["10", null, false, true, 100]);
    expect(selectCall.text).toContain("review.id IS NOT NULL");
    expect(selectCall.text).toContain("review.internal_content_hash <> internal.content_hash");
    expect(selectCall.text).toContain("review.remote_revision = revision.remote_revision");
  });

  it("keeps dictionary rows active during replacement and deactivates only missing values", async () => {
    const executor = new FakeExecutor([[], [], [], []]);
    const repository = new PostgresTargetDictionaryRepository(pool(executor));
    await repository.replaceEntityValues("10", "brands", [{ externalId: "7", name: "Nike", metadata: {} }]);

    expect(executor.calls[1]?.text).toContain("INSERT INTO target_dictionary_values");
    expect(executor.calls[2]?.text).toContain("NOT (external_id = ANY($3::TEXT[]))");
    expect(executor.calls[2]?.values).toEqual(["10", "brands", ["7"]]);
  });

  it("does not apply a source freshness TTL to approved export candidates", async () => {
    const candidateExecutor = new FakeExecutor([[]]);
    await new PostgresExportControlRepository(pool(candidateExecutor)).listExportCandidates({ targetId: "10", limit: 50 });
    expect(candidateExecutor.calls[0]?.text).not.toContain("source_refreshed_at");
    expect(candidateExecutor.calls[0]?.text).not.toContain("make_interval");
  });

  it("freezes a reviewed export batch and its jobs in one transaction", async () => {
    const executor = new FakeExecutor([
      [],
      [{ id: "51" }],
      [{ id: "61", source_product_id: "21", internal_product_id: "31" }],
      [{ job_id: "71" }],
      [],
    ]);
    const repository = new PostgresExportControlRepository(pool(executor));

    await expect(repository.createBatch({
      targetId: "10",
      filter: { riskLevel: "danger" },
      actor: "admin",
      candidates: [{
        reviewId: "11",
        sourceProductId: "21",
        internalProductId: "31",
        payloadHash: "a".repeat(64),
        willCreate: false,
        externalId: "41",
        matchedBy: "source_identity",
        riskLevel: "danger",
        changeFlags: ["taxonomy_removed:product_tag"],
        wordpressStateHash: "b".repeat(64),
      }],
    })).resolves.toEqual({
      batchId: "51",
      items: [{ id: "61", sourceProductId: "21", internalProductId: "31" }],
      jobIds: ["71"],
    });

    expect(executor.calls.map((call) => call.text.trim().split(/\s+/u)[0])).toEqual([
      "BEGIN", "INSERT", "WITH", "WITH", "COMMIT",
    ]);
    const jobCall = executor.calls[3]!;
    expect(jobCall.text).toContain("JSONB_TO_RECORDSET");
    expect(jobCall.text).toContain("INSERT INTO jobs");
    expect(jobCall.text).toContain("UPDATE target_export_batch_items");
    expect(jobCall.text).not.toContain("ON CONFLICT");
    const queued = JSON.parse(String(jobCall.values[0])) as Array<{ payload: Record<string, unknown> }>;
    expect(queued[0]?.payload).toMatchObject({
      internalProductId: "31",
      targetId: "10",
      batchItemId: "61",
      approval: {
        preflightReviewId: "11",
        payloadHash: "a".repeat(64),
        externalId: "41",
      },
    });
  });

  it("serializes template revisions and activation inside the caller transaction", async () => {
    const createExecutor = new FakeExecutor([[], [contentTemplateRow]]);
    const repository = new PostgresTargetContentTemplateRepository(createExecutor);
    const draft = await repository.createDraft({ targetId: "10", field: "description", name: "Описание", templateSource: "<p>{{ product.sku }}</p>",
      profileKey: "default", profileName: "Основной профиль", managementMode: "manage", categoryTermIds: [74, 75], requiredContextPaths: ["content.story"], actor: "admin" });

    expect(draft).toMatchObject({ id: "51", field: "description", revision: 2, status: "draft", profileKey: "default",
      managementMode: "manage", categoryTermIds: [74, 75], requiredContextPaths: ["content.story"] });
    expect(createExecutor.calls[0]?.text).toContain("pg_advisory_xact_lock");
    expect(createExecutor.calls[1]?.text).toContain("MAX(revision) + 1");

    const activeRow = { ...contentTemplateRow, status: "active", activated_at: new Date("2026-08-09T00:01:00.000Z") };
    const activateExecutor = new FakeExecutor([[contentTemplateRow], [], [activeRow]]);
    const activated = await new PostgresTargetContentTemplateRepository(activateExecutor).activate("51", "10", "admin");
    expect(activated).toMatchObject({ id: "51", status: "active", activatedAt: "2026-08-09T00:01:00.000Z" });
    expect(activateExecutor.calls[0]?.text).toContain("FOR UPDATE");
    expect(activateExecutor.calls[1]?.text).toContain("status = 'archived'");
    expect(activateExecutor.calls[2]?.text).toContain("status = 'active'");
  });

  it("maps BIGINT as strings and timestamps as ISO strings", async () => {
    const repository = new PostgresSourceRepository(new FakeExecutor([[sourceRow]]));
    const source = await repository.getById("9007199254740993");
    expect(source?.id).toBe("9007199254740993");
    expect(source?.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(source?.updatedAt).toBe("2026-01-03T03:04:05.000Z");
    expect(source?.config).toEqual({ pageSize: 10 });
  });

  it("maps enabled sources and orders them by id", async () => {
    const executor = new FakeExecutor([[sourceRow]]);
    const sources = await new PostgresSourceRepository(executor).listEnabled();
    expect(sources[0]?.adapterCode).toBe("adapter");
    expect(executor.calls[0]?.text).toMatch(/WHERE enabled = TRUE ORDER BY id/);
  });

  it("upserts a source definition by code", async () => {
    const executor = new FakeExecutor([[sourceRow]]);
    await new PostgresSourceRepository(executor).upsertDefinition({ code: "supplier", name: "Supplier", adapterCode: "adapter", config: { pageSize: 10 }, enabled: true });
    expect(executor.calls[0]?.text).toContain("ON CONFLICT (code) DO UPDATE");
    expect(executor.calls[0]?.values).toEqual(["supplier", "Supplier", "adapter", { pageSize: 10 }, true]);
  });

  it("increments source run page counters", async () => {
    const executor = new FakeExecutor([[{
      id: "1", source_id: "2", run_type: "full", coverage: "all", status: "running", completeness: "partial", checkpoint: {}, processed_count: "3", discovered_count: "2", error_count: "1", started_at: new Date(), finished_at: null, last_error: null,
    }]]);
    await new PostgresSourceRunRepository(executor).recordPage("1", { checkpoint: {}, processedCount: "3", discoveredCount: "2", errorCount: "1", completeness: "partial" });
    expect(executor.calls[0]?.text).toContain("processed_count = processed_count + $3::bigint");
    expect(executor.calls[0]?.text).toContain("discovered_count = discovered_count + $4::bigint");
    expect(executor.calls[0]?.text).toContain("error_count = error_count + $5::bigint");
  });

  it.each([[true], [false]])("returns upsertPart changed=%s from the atomic query", async (changed) => {
    const executor = new FakeExecutor([[{ ...partRow, changed }]]);
    const result = await new PostgresSourceProductRepository(executor).upsertPart({ sourceProductId: "10", partKey: "details", rawPayload: {}, parsedPayload: {}, contentHash: "hash", fetchedAt: "2026-02-01T00:00:00.000Z", adapterVersion: "1" });
    expect(result.changed).toBe(changed);
    expect(executor.calls[0]?.text).toContain("pg_advisory_xact_lock");
    expect(executor.calls[0]?.text).toContain("source_product_id = $1::bigint");
    expect(executor.calls[0]?.values.slice(2, 4)).toEqual(["{}", "{}"]);
    expect(executor.calls[0]?.text).toContain("previous.content_hash IS DISTINCT FROM $5");
  });

  it("selects a deterministic balanced cohort without collected or active products", async () => {
    const executor = new FakeExecutor([[
      { id: "10", source_key: "shoe", route: "sneakers" },
      { id: "11", source_key: "shirt", route: "apparel" },
    ]]);
    const products = await new PostgresSourceProductRepository(executor).listCollectionCandidates({
      sourceId: "1", routes: ["sneakers", "apparel"], limit: 2, seed: 7,
    });

    expect(products).toEqual([
      { id: "10", sourceKey: "shoe", route: "sneakers" },
      { id: "11", sourceKey: "shirt", route: "apparel" },
    ]);
    expect(executor.calls[0]?.text).toContain("ROW_NUMBER() OVER");
    expect(executor.calls[0]?.text).toContain("source_product_parts");
    expect(executor.calls[0]?.text).toContain("job.status IN ('pending', 'running', 'retry')");
    expect(executor.calls[0]?.values).toEqual(["1", ["sneakers", "apparel"], 2, 7]);
  });

  it("resolves contextual source decisions in one batch", async () => {
    const executor = new FakeExecutor([[{ candidate_key: "product:brand", mapping_id: "12", reference_value_id: "13", status: "confirmed", revision: "2" }]]);
    const decisions = await new PostgresClassificationRepository(executor).findSourceDecisions("4", [{ candidateKey: "product:brand", typeCode: "brand", scope: "product.brand", normalizedSourceValue: "nike", contextKey: "{}" }]);
    expect(decisions).toEqual([{ candidateKey: "product:brand", mappingId: "12", referenceValueId: "13", status: "confirmed", revision: "2" }]);
    expect(executor.calls[0]?.values[0]).toBe("4");
    expect(executor.calls[0]?.values[1]).toContain('"context_key":"{}"');
    expect(executor.calls[0]?.text).toContain("JSONB_TO_RECORDSET");
    expect(executor.calls[0]?.text).toContain("mapping.context_key = requested.context_key");
  });

  it("reads the monotonic target revision without aggregating mapping tables", async () => {
    const executor = new FakeExecutor([[{ revision: "42" }]]);
    await expect(new PostgresReferenceRepository(executor).getTargetMappingRevision("7")).resolves.toBe("42");
    const sql = executor.calls[0]?.text ?? "";
    expect(sql).toContain("target_export_revisions");
    expect(sql).not.toContain("JSONB_AGG");
    expect(executor.calls[0]?.values).toEqual(["7"]);
  });

  it("resolves classification projections in one batch", async () => {
    const executor = new FakeExecutor([[
      { id: "51", target_id: "7", mapping_id: "21", rule_id: null, target_scope: "product.tag", dictionary_value_id: "61", external_value: "892", external_label: "Lifestyle", external_slug: "lifestyle", metadata: {}, revision: "1" },
    ], [
      { id: "52", target_id: "7", reference_value_id: "31", target_scope: "product.tag", dictionary_value_id: "62", external_value: "893", external_label: "Running", external_slug: "running", metadata: {}, revision: "1" },
    ]]);
    const projections = await new PostgresReferenceRepository(executor).resolveTargetProjections("7", [{ resolutionKind: "mapping", resolutionId: "21", referenceId: "31" }]);
    expect(projections[0]).toMatchObject({ resolutionKind: "mapping", resolutionId: "21", externalValue: "892", externalSlug: "lifestyle" });
    expect(projections[1]).toMatchObject({ referenceValueId: "31", externalValue: "893", externalSlug: "running" });
    expect(executor.calls[0]?.text).toContain("dictionary.slug AS external_slug");
    expect(executor.calls[0]?.text).toContain("JSONB_TO_RECORDSET");
    expect(executor.calls[0]?.values[1]).toContain('"resolution_kind":"mapping"');
    expect(executor.calls[0]?.values[1]).toContain('"reference_id":"31"');
  });

  it("previews rule projections through observation rule_id columns", async () => {
    const executor = new FakeExecutor([
      [{ id: "21" }],
      [],
      [{ observation_count: 0, product_count: 0, source_product_ids: [] }],
      [],
      [],
    ]);
    await new PostgresClassificationAdminRepository(pool(executor)).previewTargetProjection({
      targetId: "7",
      resolutionKind: "rule",
      resolutionId: "21",
      targetScope: "product.tag",
      dictionaryValueId: "61",
      targetCardinality: "multiple",
      actor: "test",
    });
    const sql = executor.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("observation.rule_id = $2");
    expect(sql).not.toContain("observation.resolution_kind");
  });

  it("previews mapping projections with typed target id in stats query", async () => {
    const executor = new FakeExecutor([
      [{ id: "21" }],
      [],
      [{ observation_count: 0, product_count: 0, source_product_ids: [] }],
      [],
      [],
    ]);
    await new PostgresClassificationAdminRepository(pool(executor)).previewTargetProjection({
      targetId: "7",
      resolutionKind: "mapping",
      resolutionId: "21",
      targetScope: "product.tag",
      dictionaryValueId: "61",
      targetCardinality: "multiple",
      actor: "test",
    });
    const statsSql = executor.calls[2]?.text ?? "";
    expect(statsSql).toContain("$1::BIGINT IS NOT NULL");
    expect(statsSql).toContain("observation.mapping_id = $2");
  });

  it("narrows the review queue to the exact product context", async () => {
    const executor = new FakeExecutor([[]]);
    await new PostgresClassificationAdminRepository(pool(executor)).listReviewQueue({
      sourceId: "1",
      typeCode: "category",
      status: "unresolved",
      search: "sneakers",
      contextKey: "context-women",
      limit: 50,
      offset: 0,
    });

    expect(executor.calls[0]?.text).toContain("review.context_key = $6");
    expect(executor.calls[0]?.values[5]).toBe("context-women");
  });

  it("updates classifier review counters by product delta and preserves ambiguous rule matches", async () => {
    const executor = new FakeExecutor([[], [], [], [], [], []]);
    await new PostgresClassificationRepository(executor).saveProductResult({
      sourceId: "1",
      sourceProductId: "10",
      processorVersion: "2.9.0",
      classifierVersion: "1.0.0",
      fingerprint: "fingerprint",
      observations: [{
        candidate: {
          key: "product:category",
          typeCode: "category",
          scope: "product.category",
          subjectKind: "product",
          sourceValue: "sneakers",
          context: {},
          evidence: {},
        },
        normalizedSourceValue: "sneakers",
        contextKey: "{}",
        status: "ambiguous",
        issueReason: "rule_ambiguous",
        referenceValueId: null,
        resolutionKind: null,
        resolutionId: null,
        resolutionRevision: null,
        matchedRuleIds: ["5", "6"],
      }],
    });

    expect(executor.calls[0]?.text).toContain("classification_review_product_contributions");
    expect(executor.calls[1]?.text).toContain("NOT EXISTS");
    expect(executor.calls[2]?.text).toContain("active = FALSE");
    expect(executor.calls[3]?.text).toContain("INSERT INTO classification_candidates");
    expect(executor.calls[3]?.text).toContain("INSERT INTO source_product_classification_evidence");
    expect(executor.calls[3]?.text).toContain("INSERT INTO source_product_classification_states");
    expect(executor.calls[3]?.values[2]).toBe("2.9.0");
    expect(executor.calls[4]?.text).toContain("INSERT INTO source_product_classification_links");
    expect(executor.calls[4]?.text).toContain("IS DISTINCT FROM");
    expect(executor.calls[4]?.text).toContain("INSERT INTO classification_review_rule_coverage");
    expect(executor.calls[4]?.values[2]).toContain('"matched_rule_ids":["5","6"]');
    expect(executor.calls[6]?.text).toContain("apply_classification_review_product_contributions");
  });

  it("lists review groups without scanning observations for examples", async () => {
    const executor = new FakeExecutor([[]]);
    await new PostgresClassificationAdminRepository(pool(executor)).listReviewQueue({
      limit: 200,
      offset: 0,
    });

    const sql = executor.calls[0]?.text ?? "";
    expect(sql).toContain("review_page AS MATERIALIZED");
    expect(sql).toContain("FROM classification_review_groups review");
    expect(sql).toContain("review_page.id AS review_group_id");
    expect(sql).toContain("LIMIT $7 OFFSET $8");
    expect(sql).toContain("review.id DESC");
    expect(sql).not.toContain("source_reference_observations");
    expect(sql).not.toContain("classification_review_rule_resolutions");
  });

  it("counts every review group matching the queue filters", async () => {
    const executor = new FakeExecutor([[{ total: "321" }]]);
    const total = await new PostgresClassificationAdminRepository(pool(executor)).countReviewQueue({
      sourceId: "1",
      typeCode: "category",
      status: "unresolved",
      search: "sneakers",
      contextKey: "context-women",
      limit: 200,
      offset: 0,
    });

    expect(total).toBe(321);
    expect(executor.calls[0]?.text).toContain("COUNT(*)::INTEGER AS total");
    expect(executor.calls[0]?.text).toContain("FROM classification_review_groups review");
    expect(executor.calls[0]?.text).toContain("review.context_key = $6");
    expect(executor.calls[0]?.values).toEqual(["1", "category", "unresolved", "sneakers", "{}", "context-women"]);
  });

  it("finds exact target matches in one indexed paginated query", async () => {
    const executor = new FakeExecutor([[{
      total: 1,
      ready_count: 1,
      ready_product_count: 8,
      duplicate_count: 0,
      conflict_count: 0,
      items: [{
        reviewGroupId: "77", sourceId: "1", sourceCode: "goat", sourceName: "GOAT",
        typeCode: "brand", typeName: "Бренд", scope: "product.brand",
        normalizedSourceValue: "sporty & rich", contextKey: "{}", sourceValue: "Sporty & Rich",
        productCount: 8, observationCount: 8, targetScope: "product.brand", matchStatus: "ready",
        issueReason: null,
        targets: [{ dictionaryValueId: "88", externalId: "4262", name: "Sporty & Rich", slug: "sporty-amp-rich", taxonomy: "pa_brand" }],
      }],
    }]]);

    const result = await new PostgresClassificationAdminRepository(pool(executor)).listExactMatches({
      targetId: "10",
      capabilities: [{ typeCode: "brand", entityType: "brands", targetScope: "product.brand" }],
      sourceId: "1",
      status: "ready",
      search: "Sporty",
      limit: 50,
      offset: 0,
      currentProcessorVersions: { "1": "2.9.0" },
    });

    expect(result).toMatchObject({ total: 1, summary: { readyCount: 1, readyProductCount: 8 } });
    expect(result.items[0]).toMatchObject({
      reviewGroupId: "77",
      matchStatus: "ready",
      targets: [{ dictionaryValueId: "88", externalId: "4262" }],
    });
    const call = executor.calls[0]!;
    expect(call.text).toContain("FROM dictionary_candidates dictionary");
    expect(call.text).toContain("JOIN classification_review_groups review");
    expect(call.text).toContain("LOWER(NORMALIZE(BTRIM(dictionary.name), NFKC)) AS normalized_target_name");
    expect(call.text).toContain("review.normalized_source_value = dictionary.normalized_target_name");
    expect(call.text).toContain("LIMIT $9 OFFSET $10");
    expect(call.values).toHaveLength(10);
  });

  it("uses indexed substring search and indexed prefixes for short values", async () => {
    const substringExecutor = new FakeExecutor([[]]);
    await new PostgresClassificationAdminRepository(pool(substringExecutor)).listReviewQueue({
      search: "fly",
      limit: 200,
      offset: 0,
    });
    expect(substringExecutor.calls[0]?.text).toContain("review.source_value ILIKE '%' || $4::TEXT || '%'");

    const prefixExecutor = new FakeExecutor([[{ total: "1" }]]);
    await new PostgresClassificationAdminRepository(pool(prefixExecutor)).countReviewQueue({
      search: "dc",
      limit: 200,
      offset: 0,
    });
    expect(prefixExecutor.calls[0]?.text).toContain("LOWER(review.source_value) LIKE LOWER($4::TEXT) || '%'");
  });

  it("loads examples only for one materialized review group", async () => {
    const executor = new FakeExecutor([[{ examples: [], total: "90" }]]);
    const result = await new PostgresClassificationAdminRepository(pool(executor)).listReviewExamples({
      reviewGroupId: "42",
      search: "Vans",
      limit: 50,
      offset: 100,
      currentProcessorVersions: { "1": "2.9.0" },
    });

    const call = executor.calls[0];
    const sql = call?.text ?? "";
    expect(sql).toContain("WHERE review.id = $1");
    expect(sql).toContain("candidate AS MATERIALIZED");
    expect(sql).not.toContain("classification_review_rule_resolutions");
    expect(sql).not.toContain("source_reference_mappings");
    expect(sql).toContain("matching_links AS MATERIALIZED");
    expect(sql).toContain("filtered_links AS MATERIALIZED");
    expect(sql).toContain("source_product_classification_links link");
    expect(sql).not.toContain("source_reference_observations");
    expect(sql).toContain("product.id::TEXT = $3");
    expect(sql).toContain("LIMIT $4 OFFSET $5");
    expect(sql).toContain("COUNT(*)::INTEGER FROM filtered_links");
    expect(sql).toContain("snapshot.payload->'product'->'taxonomies'");
    expect(call?.values).toEqual(["42", '{"1":"2.9.0"}', "Vans", 50, 100]);
    expect(result).toEqual({ items: [], total: 90 });
  });

  it("previews an exact decision without returning every affected product id", async () => {
    const executor = new FakeExecutor([[
      {
        observation_count: "13067",
        product_count: "13067",
        current_status: null,
        current_reference_value_id: null,
        examples: [],
      },
    ]]);
    const result = await new PostgresClassificationAdminRepository(pool(executor)).previewDecision({
      sourceId: "1",
      typeCode: "merchandising_category",
      scope: "product.merchandising_category",
      normalizedSourceValue: "skateboarding",
      contextKey: "context-men",
      action: "confirm",
      referenceValueId: "148",
      actor: "admin",
    });

    const sql = executor.calls[0]?.text ?? "";
    expect(sql).toContain("example_links AS MATERIALIZED");
    expect(sql).toContain("classification_candidates definition");
    expect(sql).not.toContain("JSONB_AGG(DISTINCT source_product_id");
    expect(sql).not.toContain("source_reference_observations");
    expect(result).toMatchObject({ observationCount: 13067, productCount: 13067, unchanged: false });
    expect(result).not.toHaveProperty("affectedSourceProductIds");
  });

  it("saves an exact decision with set-based job enqueueing", async () => {
    const mapping = { id: "152", revision: "1", status: "confirmed", reference_value_id: "148" };
    const executor = new FakeExecutor([
      [],
      [{
        id: "901",
        candidate_id: "501",
        type_id: "16",
        source_value: "Skateboarding",
        context: { audience: "men" },
      }],
      [{ id: "148" }],
      [],
      [mapping],
      [],
      [],
      [{ affected_product_count: "13067" }],
      [],
    ]);
    const result = await new PostgresClassificationAdminRepository(pool(executor)).saveDecision({
      sourceId: "1",
      typeCode: "merchandising_category",
      scope: "product.merchandising_category",
      normalizedSourceValue: "skateboarding",
      contextKey: "context-men",
      action: "confirm",
      referenceValueId: "148",
      actor: "admin",
    });

    const sql = executor.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("classification_candidates candidate");
    expect(sql).toContain("FOR UPDATE OF link");
    expect(sql).toContain("UPDATE classification_review_groups review");
    expect(sql).toContain("affected AS MATERIALIZED");
    expect(sql).toContain("'reclassify_product'");
    expect(sql).toContain("DO NOTHING");
    expect(sql).not.toContain("refresh_classification_review_groups");
    expect(sql).not.toContain("DO UPDATE SET unique_key = jobs.unique_key");
    expect(result).toEqual({
      mappingId: "152",
      referenceValueId: "148",
      revision: "1",
      affectedProductCount: 13067,
      affectedExportCount: 0,
    });
  });

  it("lists rule fields without aggregating every observed value", async () => {
    const executor = new FakeExecutor([[
      { field: "sourceValue", examples: [] },
      { field: "context.brand", examples: [] },
    ]]);
    const fields = await new PostgresClassificationAdminRepository(pool(executor))
      .listRuleConditionFields("1", "model", "2.9.0");

    const call = executor.calls[0]!;
    expect(call.text).toContain("current_evidence AS MATERIALIZED");
    expect(call.text).toContain("JSONB_TYPEOF(entry.value) IN ('string', 'number', 'boolean')");
    expect(call.text).not.toContain("ARRAY_AGG(DISTINCT value");
    expect(call.values).toEqual(["1", "model", "2.9.0"]);
    expect(fields).toEqual([
      { field: "sourceValue", exampleValues: [] },
      { field: "context.brand", exampleValues: [] },
    ]);
  });

  it("prefilters rule candidates with normalized SQL conditions", async () => {
    const executor = new FakeExecutor([[]]);
    await new PostgresClassificationAdminRepository(pool(executor)).listRuleCandidates(
      "1",
      "category",
      "2.9.0",
      [
        { field: "sourceValue", operator: "equals", value: " Sneakers " },
        { field: "context.audience", operator: "equals", value: "Youth" },
      ],
    );

    const call = executor.calls[0]!;
    expect(call.text).toContain("observation.normalized_source_value = $4");
    expect(call.text).toContain("observation.context ->> $5");
    expect(call.values).toEqual(["1", "category", "2.9.0", "sneakers", "audience", "youth"]);
  });

  it("resolves an existing internal value for a rule selected from a target term", async () => {
    const executor = new FakeExecutor([[{ reference_value_id: "23" }]]);
    const referenceValueId = await new PostgresClassificationAdminRepository(pool(executor)).findRuleTargetReference({
      typeCode: "category", targetId: "1", targetScope: "product.category", dictionaryValueId: "88",
    });

    expect(referenceValueId).toBe("23");
    expect(executor.calls[0]?.text).toContain("mapping.dictionary_value_id = $3");
    expect(executor.calls[0]?.values).toEqual(["1", "product.category", "88", "category"]);
  });

  it("creates a rule from an already linked target term without creating an exact source mapping", async () => {
    const executor = new FakeExecutor([
      [],
      [{ type_id: "5" }],
      [{ id: "88", target_id: "1", entity_type: "product_categories", external_id: "74", name: "Кроссовки женские", slug: "krossovki-zhenskie", taxonomy: "product_cat", attribute_code: null }],
      [{ reference_value_id: "23" }],
      [{ dictionary_value_id: "88", active: true }],
      [{ id: "31", dictionary_value_id: "88", active: true }],
      [{ id: "23" }],
      [{ id: "22", revision: "1" }],
      [],
      [],
    ]);
    const result = await new PostgresClassificationAdminRepository(pool(executor)).createRule({
      sourceId: "1", typeCode: "category", name: "Женские кроссовки", priority: 100,
      conditions: [{ field: "context.audience", operator: "equals", value: "women" }],
      referenceValueId: "23",
      targetLink: { targetId: "1", targetScope: "product.category", dictionaryValueId: "88" },
      actor: "admin", affectedSourceProductIds: [], matchedObservationIds: [],
    });

    expect(result).toMatchObject({ ruleId: "22", referenceValueId: "23", affectedProductCount: 0 });
    const sql = executor.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("INSERT INTO source_reference_rules");
    expect(sql).not.toContain("INSERT INTO source_reference_mappings");
  });

  it("soft deletes a rule and deactivates its projections while preserving audit", async () => {
    const previousRule = { id: "22", revision: "1", enabled: true, deleted_at: null };
    const previousProjection = { id: "46", revision: "1", active: true, rule_id: "22" };
    const executor = new FakeExecutor([
      [], [previousRule], [], [previousProjection],
      [{ ...previousRule, revision: "2", enabled: false, deleted_at: "2026-08-07T00:00:00Z" }],
      [], [{ ...previousProjection, revision: "2", active: false }], [], [],
    ]);

    const result = await new PostgresClassificationAdminRepository(pool(executor)).deleteRule({
      ruleId: "22", actor: "admin", affectedSourceProductIds: [],
    });

    expect(result).toEqual({ revision: "2", affectedProductCount: 0 });
    const sql = executor.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("deleted_at = NOW()");
    expect(sql).toContain("UPDATE target_classification_projections");
    expect(sql).toContain("'delete'");
  });

  it("loads one classifier configuration record by kind and id", async () => {
    const executor = new FakeExecutor([[{ total: "0" }], [], [], [], []]);
    await new PostgresClassificationAdminRepository(pool(executor)).listConfiguration({
      kind: "rule",
      configId: "8",
      limit: 50,
      offset: 0,
    });

    expect(executor.calls[0]?.text).toContain("item.id = $2");
    expect(executor.calls[0]?.values.slice(0, 2)).toEqual(["rule", "8"]);
    expect(executor.calls[1]?.text).not.toContain("current_products AS MATERIALIZED");
    expect(executor.calls[1]?.text).toContain("state.processor_version");
    expect(executor.calls[1]?.text).toContain("source_product_classification_links");
    expect(executor.calls[1]?.text).not.toContain("source_reference_observations");
    expect(executor.calls[1]?.text).toContain("observation_stats AS MATERIALIZED");
    expect(executor.calls[1]?.text).toContain("example_observations AS MATERIALIZED");
    expect(executor.calls[1]?.text).toContain("JOIN LATERAL");
    expect(executor.calls[1]?.text).toContain("$10::BOOLEAN");
    expect(executor.calls[1]?.values[9]).toBe(true);
    expect(executor.calls[1]?.text).not.toContain("matched_observations AS MATERIALIZED");
  });

  it("saves a target snapshot and links the observed target product atomically", async () => {
    const executor = new FakeExecutor([[targetSnapshotRow]]);
    const snapshot = await new PostgresTargetRepository(executor).saveProductSnapshot({ targetId: "1", sourceProductId: "2", externalId: "321", sourceExternalId: "100", payload: { product: { target_id: 321 } }, contentHash: "snapshot-hash", fetchedAt: "2026-04-02T00:00:00.000Z" });
    expect(snapshot).toMatchObject({ externalId: "321", sourceExternalId: "100", contentHash: "snapshot-hash" });
    expect(executor.calls[0]?.text).toContain("WITH snapshot AS");
    expect(executor.calls[0]?.text).toContain("INSERT INTO target_products");
  });

  it("does not overwrite successful export fields on failure", async () => {
    const executor = new FakeExecutor([[targetProductRow]]);
    const product = await new PostgresTargetRepository(executor).saveExportFailure({ targetId: "1", internalProductId: "2", status: "failed", error: "failure", attemptedAt: "2026-04-01T00:00:00.000Z" });
    const updateClause = executor.calls[0]?.text.split("DO UPDATE SET")[1] ?? "";
    expect(updateClause).not.toMatch(/external_id\s*=/);
    expect(updateClause).not.toMatch(/last_exported_hash\s*=/);
    expect(updateClause).not.toMatch(/last_export_fingerprint\s*=/);
    expect(updateClause).not.toMatch(/synced_at\s*=/);
    expect(product.externalId).toBe("external");
  });

  it("returns an active enqueue conflict without replacing its payload", async () => {
    const executor = new FakeExecutor([[jobRow]]);
    await new PostgresJobRepository(executor).enqueue({ jobType: "collect_product", payload: { replacement: true }, uniqueKey: "product-1" });
    const sql = executor.calls[0]?.text ?? "";
    expect(sql).toContain("WHERE status IN ('pending', 'running', 'retry')");
    expect(sql).toContain("SET unique_key = jobs.unique_key");
    expect(sql.split("DO UPDATE SET")[1]).not.toMatch(/payload\s*=/);
  });

  it("enqueues large job sets in bounded SQL batches", async () => {
    const executor = new FakeExecutor([[], []]);
    const inputs = Array.from({ length: 1_001 }, (_, index) => ({
      jobType: "process_product" as const,
      payload: { sourceProductId: String(index + 1), force: false },
      uniqueKey: `source-product:${index + 1}:process`,
    }));

    await new PostgresJobRepository(executor).enqueueMany(inputs);

    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]?.values).toHaveLength(4_000);
    expect(executor.calls[1]?.values).toHaveLength(4);
  });

  it("checks expired jobs before atomically claiming an available job", async () => {
    const executor = new FakeExecutor([[], [jobRow]]);
    await new PostgresJobRepository(executor).claimNext("worker", 30000, ["process_product"]);
    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]?.text).toContain("ORDER BY locked_at, id");
    expect(executor.calls[0]?.text).toContain("status = 'running'");
    expect(executor.calls[0]?.text).toContain("job_type = $3::TEXT");
    expect(executor.calls[0]?.values).toEqual(["worker", 30000, "process_product"]);
    expect(executor.calls[1]?.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(executor.calls[1]?.text).toContain("status IN ('pending', 'retry')");
    expect(executor.calls[1]?.text).toContain("attempts = attempts + 1");
    expect(executor.calls[1]?.text).toContain("ORDER BY available_at, id");
    expect(executor.calls[1]?.text).toContain("job_type = $2::TEXT");
    expect(executor.calls[1]?.values).toEqual(["worker", "process_product"]);
  });

  it("returns an expired job without scanning the available queue", async () => {
    const executor = new FakeExecutor([[jobRow]]);
    await new PostgresJobRepository(executor).claimNext("worker", 30000, ["process_product"]);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.text).toContain("locked_at <");
  });

  it("does not claim reclassification while bulk classification application is active", async () => {
    const executor = new FakeExecutor([[], []]);
    await new PostgresJobRepository(executor).claimNext("worker", 30000, ["reclassify_product"]);

    expect(executor.calls[0]?.text).toContain("application_job.job_type = 'apply_target_classification_suggestion'");
    expect(executor.calls[1]?.text).toContain("jobs.job_type <> 'reclassify_product'");
  });

  it("claims a bounded batch for one job type", async () => {
    const executor = new FakeExecutor([[], [jobRow, { ...jobRow, id: "2" }]]);
    const result = await new PostgresJobRepository(executor).claimMany("worker", 30000, "reclassify_product", 16);

    expect(result).toHaveLength(2);
    expect(executor.calls[0]?.text).toContain("LIMIT $4");
    expect(executor.calls[1]?.text).toContain("job_type = $2");
    expect(executor.calls[1]?.text).toContain("LIMIT $3");
    expect(executor.calls[1]?.values).toEqual(["worker", "reclassify_product", 16]);
  });

  it("deletes expired operational data in bounded batches", async () => {
    const executor = new FakeExecutor([
      [{ id: "1" }, { id: "2" }],
      [{ id: "3" }],
      [],
      [{ attempts: 1, operations: 7 }],
      [],
    ]);
    const result = await new DatabaseRetentionService(pool(executor)).cleanup({
      completedJobsBefore: new Date("2026-08-08T00:00:00.000Z"),
      failedJobsBefore: new Date("2026-07-10T00:00:00.000Z"),
      processingHistoryBefore: new Date("2026-07-10T00:00:00.000Z"),
      inactiveObservationsBefore: new Date("2026-07-10T00:00:00.000Z"),
      batchSize: 2,
    });

    expect(result).toEqual({
      completedJobs: 3,
      failedJobs: 0,
      processingAttempts: 1,
      operationExecutions: 7,
      inactiveObservations: 0,
      orphanedClassificationEvidence: 0,
      orphanedClassificationCandidates: 0,
    });
    expect(executor.calls[0]?.text).toContain("status = 'completed'");
    expect(executor.calls[0]?.text).toContain("LIMIT $2");
    expect(executor.calls[3]?.text).toContain("deleted_operations AS");
    expect(executor.calls[4]?.text).toContain("active = FALSE");
    expect(executor.calls[5]?.text).toContain("source_product_classification_evidence");
    expect(executor.calls[6]?.text).toContain("classification_candidates");
    expect(executor.calls[5]?.text).toContain("FOR UPDATE OF evidence SKIP LOCKED");
    expect(executor.calls[6]?.text).toContain("FOR UPDATE OF candidate SKIP LOCKED");
  });

  it("claims only an explicitly selected pending processing job", async () => {
    const executor = new FakeExecutor([[jobRow]]);
    await new PostgresJobRepository(executor).claimById("42", "worker:manual", ["process_product"]);
    const call = executor.calls[0];
    expect(call?.text).toContain("WHERE id = $1");
    expect(call?.text).toContain("job_type = ANY($3::TEXT[])");
    expect(call?.text).toContain("status IN ('pending', 'retry')");
    expect(call?.text).toContain("started_at = NOW()");
    expect(call?.text).not.toContain("ORDER BY");
    expect(call?.values).toEqual(["42", "worker:manual", ["process_product"]]);
  });

  it("uses the computed target status for both filtering and product rows", async () => {
    const executor = new FakeExecutor([
      [{ total: "1" }],
      [{
        source_product_id: "2", source_id: "1", source_code: "goat", source_name: "GOAT",
        source_key: "shoe", external_id: "100", title: "Shoe", source_status: "active",
        stage: "classified", classification_status: "complete", collected_at: new Date("2026-08-01T00:00:00Z"),
        processed_at: new Date("2026-08-01T01:00:00Z"), target_status: "observed", target_job_status: null,
        target_external_id: "321", has_target_snapshot: true,
      }],
      [{ code: "goat", name: "GOAT" }],
    ]);

    const result = await new PostgresProductAdminRepository(pool(executor)).listProducts({ targetStatus: "observed", limit: 50, offset: 0 });

    expect(result.items[0]).toMatchObject({ targetStatus: "observed", targetJobStatus: null });
    expect(executor.calls[0]?.values).toContain("observed");
    expect(executor.calls[0]?.text).toContain("internal.id::TEXT NOT IN");
    expect(executor.calls[0]?.text).toContain("target_product.status = $1");
    expect(executor.calls[0]?.text).toContain("export_target.id::TEXT = job.payload->>'targetId'");
    expect(executor.calls[1]?.text).toContain("CASE WHEN active_export.status IS NOT NULL THEN 'pending'");
  });

  it("reports an active export job ahead of a stored target status", async () => {
    const executor = new FakeExecutor([
      [{ total: "1" }],
      [{
        source_product_id: "2", source_id: "1", source_code: "goat", source_name: "GOAT",
        source_key: "shoe", external_id: "100", title: "Shoe", source_status: "active",
        stage: "classified", classification_status: "complete", collected_at: null, processed_at: null,
        target_status: "pending", target_job_status: "running", target_external_id: "321", has_target_snapshot: false,
      }],
      [],
    ]);

    const result = await new PostgresProductAdminRepository(pool(executor)).listProducts({ targetStatus: "pending", limit: 50, offset: 0 });

    expect(result.items[0]).toMatchObject({ targetStatus: "pending", targetJobStatus: "running" });
    expect(executor.calls[0]?.text).toContain("job.status IN ('pending', 'running', 'retry')");
    expect(executor.calls[0]?.text).toContain("export_target.id::TEXT = job.payload->>'targetId'");
  });

  it("builds indexed numeric job search without joining the whole jobs table", async () => {
    const executor = new FakeExecutor([
      [{ total: "1" }],
      [{ ...jobRow, source_product_id: "87549", duration_ms: 1000 }],
      [],
      [],
      [],
      [{ job_type: "process_product", remaining: 2, last15m: 10, last1h: 20, last24h: 30, concurrency: 3, estimated_duration_ms: 12_500, eta_basis: "duration", eta_minutes: 1 }],
    ]);

    const result = await new PostgresProductAdminRepository(pool(executor)).listJobs({ search: "87549", limit: 50, offset: 0 });

    expect(result.total).toBe(1);
    expect(executor.calls[0]?.values[0]).toBe("87549");
    expect(executor.calls[0]?.text).toContain("job.id = $1::BIGINT");
    expect(executor.calls[0]?.text).toContain("job.payload->>'sourceProductId' = $1::TEXT");
    expect(executor.calls[0]?.text).toContain("searched_internal.source_product_id = $1::BIGINT");
    expect(executor.calls[0]?.text).not.toContain("internal.source_product_id::TEXT = $1");
    expect(executor.calls[1]?.text).toContain("internal.id = NULLIF(job.payload->>'internalProductId', '')::BIGINT");
    expect(executor.calls[5]?.text).toContain("finished_at >= NOW() - INTERVAL '24 hours'");
    expect(executor.calls[5]?.text).toContain("GROUP BY job_type");
    expect(executor.calls[5]?.text).toContain("PERCENTILE_CONT(0.75)");
    expect(executor.calls[5]?.text).toContain("applied_process_concurrency");
    expect(executor.calls[5]?.text).toContain("remaining * estimated_duration_ms / (concurrency * 60000)");
    expect(executor.calls[1]?.text).toContain("job.finished_at - job.started_at");
    expect(result.summary.byJobType[0]).toEqual({
      jobType: "process_product",
      remaining: 2,
      completion: { last15m: 10, last1h: 20, last24h: 30 },
      concurrency: 3,
      estimatedDurationMs: 12_500,
      etaBasis: "duration",
      etaMinutes: 1,
    });
  });

  it("initializes and marks runtime worker settings as applied", async () => {
    const row = {
      singleton: true,
      collection_concurrency: 15,
      process_concurrency: 10,
      preflight_concurrency: 4,
      classification_apply_concurrency: 4,
      refresh_source_before_export: true,
      revision: "2",
      updated_by: "admin",
      updated_at: new Date("2026-08-11T12:00:00.000Z"),
      applied_revision: "2",
      applied_collection_concurrency: 15,
      applied_process_concurrency: 10,
      applied_preflight_concurrency: 4,
      applied_classification_apply_concurrency: 4,
      applied_refresh_source_before_export: true,
      applied_worker_id: "production",
      applied_at: new Date("2026-08-11T12:01:00.000Z"),
    };
    const executor = new FakeExecutor([[], [], [row], [row], []]);
    const repository = new PostgresRuntimeWorkerSettingsRepository(pool(executor));

    const result = await repository.loadAndMarkApplied({
      collectionConcurrency: 1,
      processConcurrency: 1,
      preflightConcurrency: 1,
      classificationApplyConcurrency: 1,
      refreshSourceBeforeExport: true,
    }, "production");

    expect(result).toMatchObject({
      collectionConcurrency: 15,
      processConcurrency: 10,
      preflightConcurrency: 4,
      classificationApplyConcurrency: 4,
      refreshSourceBeforeExport: true,
      revision: "2",
      applied: { revision: "2", workerId: "production", preflightConcurrency: 4, refreshSourceBeforeExport: true },
    });
    expect(executor.calls[1]?.text).toContain("ON CONFLICT (singleton) DO NOTHING");
    expect(executor.calls[3]?.text).toContain("applied_preflight_concurrency = preflight_concurrency");
    expect(executor.calls[3]?.text).toContain("applied_classification_apply_concurrency = classification_apply_concurrency");
    expect(executor.calls[3]?.text).toContain("applied_refresh_source_before_export = refresh_source_before_export");
  });

  it("increments and audits a changed runtime worker settings revision", async () => {
    const current = {
      singleton: true,
      collection_concurrency: 15,
      process_concurrency: 10,
      preflight_concurrency: 1,
      classification_apply_concurrency: 1,
      refresh_source_before_export: true,
      revision: "7",
      updated_by: "environment",
      updated_at: new Date("2026-08-11T12:00:00.000Z"),
      applied_revision: "7",
      applied_collection_concurrency: 15,
      applied_process_concurrency: 10,
      applied_preflight_concurrency: 1,
      applied_classification_apply_concurrency: 1,
      applied_refresh_source_before_export: true,
      applied_worker_id: "production",
      applied_at: new Date("2026-08-11T12:00:00.000Z"),
    };
    const updated = { ...current, preflight_concurrency: 4, classification_apply_concurrency: 4, refresh_source_before_export: false, revision: "8", updated_by: "admin" };
    const executor = new FakeExecutor([[], [current], [updated], [], []]);
    const repository = new PostgresRuntimeWorkerSettingsRepository(pool(executor));

    const result = await repository.save({
      collectionConcurrency: 15,
      processConcurrency: 10,
      preflightConcurrency: 4,
      classificationApplyConcurrency: 4,
      refreshSourceBeforeExport: false,
    }, "admin");

    expect(result).toMatchObject({ revision: "8", preflightConcurrency: 4, refreshSourceBeforeExport: false, applied: { revision: "7", preflightConcurrency: 1, refreshSourceBeforeExport: true } });
    expect(executor.calls[2]?.values).toEqual([15, 10, 4, 4, false, "8", "admin"]);
    expect(executor.calls[3]?.values).toEqual([
      "8",
      JSON.stringify({ collectionConcurrency: 15, processConcurrency: 10, preflightConcurrency: 1, classificationApplyConcurrency: 1, refreshSourceBeforeExport: true }),
      JSON.stringify({ collectionConcurrency: 15, processConcurrency: 10, preflightConcurrency: 4, classificationApplyConcurrency: 4, refreshSourceBeforeExport: false }),
      "admin",
    ]);
  });

  it("serializes every JSON batch audit field as JSON", async () => {
    const executor = new FakeExecutor([[{ id: "12" }]]);
    const filter = { selectedIds: ["83548"], limit: 1 };
    const dryRun = {
      action: "process" as const,
      selectedCount: 1,
      eligibleCount: 1,
      skippedCount: 0,
      activeDuplicateCount: 0,
      jobsToCreate: 1,
      force: false,
      enqueueProcessing: null,
      skipReasons: [],
      sampleProductIds: ["83548"],
      estimatedImages: 1,
      disk: { availableBytes: 1000, warning: null },
    };

    const id = await new PostgresProductAdminRepository(pool(executor)).saveBatchAudit({
      action: "process",
      filter,
      dryRun,
      createdJobIds: ["350950"],
      actor: "admin",
    });

    expect(id).toBe("12");
    expect(executor.calls[0]?.values.slice(1, 4)).toEqual([
      JSON.stringify(filter),
      JSON.stringify(dryRun),
      JSON.stringify(["350950"]),
    ]);
  });

  it.each(["complete", "retry", "fail"] as const)("%s clears the job lock", async (operation) => {
    const executor = new FakeExecutor([[{ id: "21" }]]);
    const repository = new PostgresJobRepository(executor);
    if (operation === "complete") await repository.complete("21");
    else if (operation === "retry") await repository.retry("21", { error: "retry", availableAt: "2026-05-01T00:00:00.000Z" });
    else await repository.fail("21", "failed");
    expect(executor.calls[0]?.text).toContain("locked_at = NULL");
    expect(executor.calls[0]?.text).toContain("locked_by = NULL");
  });
});
