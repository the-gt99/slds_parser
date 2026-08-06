import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  PostgresClassificationRepository,
  PostgresClassificationAdminRepository,
  PostgresJobRepository,
  PostgresProductAdminRepository,
  PostgresReferenceRepository,
  PostgresSourceProductRepository,
  PostgresSourceRepository,
  PostgresSourceRunRepository,
  PostgresTargetRepository,
} from "../../src/infrastructure/db/index.js";
import type { SqlExecutor, SqlPool, SqlResult } from "../../src/infrastructure/db/index.js";

interface Call { readonly text: string; readonly values: readonly unknown[] }

class FakeExecutor implements SqlExecutor {
  readonly calls: Call[] = [];
  constructor(private readonly results: QueryResultRow[][]) {}
  async query<Row extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<SqlResult<Row>> {
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

describe("PostgreSQL repository mapping and SQL", () => {
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

  it("builds mapping revision from sorted mapping contents", async () => {
    const executor = new FakeExecutor([[{ revision: "abc" }]]);
    await expect(new PostgresReferenceRepository(executor).getTargetMappingRevision("7")).resolves.toBe("abc");
    const sql = executor.calls[0]?.text ?? "";
    for (const field of ["external_value", "external_label", "mapping.metadata", "mapping.updated_at", "projection.dictionary_value_id", "ORDER BY mapping.id", "ORDER BY projection.id"]) expect(sql).toContain(field);
  });

  it("resolves classification projections in one batch", async () => {
    const executor = new FakeExecutor([[
      { id: "51", target_id: "7", mapping_id: "21", rule_id: null, target_scope: "product.tag", dictionary_value_id: "61", external_value: "892", external_label: "Lifestyle", metadata: {}, revision: "1" },
    ]]);
    const projections = await new PostgresReferenceRepository(executor).resolveTargetProjections("7", [{ resolutionKind: "mapping", resolutionId: "21" }]);
    expect(projections[0]).toMatchObject({ resolutionKind: "mapping", resolutionId: "21", externalValue: "892" });
    expect(executor.calls[0]?.text).toContain("JSONB_TO_RECORDSET");
    expect(executor.calls[0]?.values[1]).toContain('"resolution_kind":"mapping"');
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

  it("atomically claims available or expired jobs and increments attempts", async () => {
    const executor = new FakeExecutor([[jobRow]]);
    await new PostgresJobRepository(executor).claimNext("worker", 30000, ["process_product"]);
    const call = executor.calls[0];
    expect(call?.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(call?.text).toContain("status = 'running' AND locked_at <");
    expect(call?.text).toContain("attempts = attempts + 1");
    expect(call?.text).toContain("ORDER BY available_at, id");
    expect(call?.text).toContain("job_type = ANY($3::TEXT[])");
    expect(call?.values).toEqual(["worker", 30000, ["process_product"]]);
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
