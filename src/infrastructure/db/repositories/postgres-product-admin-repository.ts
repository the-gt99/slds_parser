import type { JsonObject } from "../../../contracts/index.js";
import type {
  ProductAdminReadModel,
  ProductAdminRepository,
  ProductClassificationObservationRecord,
  ProductOperationExecutionRecord,
  ProductPartSummaryRecord,
  ProductProcessingAttemptRecord,
  ProductListQuery,
  ProductListResult,
  ProductSnapshotListItem,
  ProductSnapshotListQuery,
  ProductSnapshotListResult,
  ProductTargetSnapshotRecord,
} from "../../../repositories/index.js";
import type { SqlPool } from "../sql-executor.js";
import {
  mapInternalProduct,
  mapJob,
  mapSource,
  mapSourceProduct,
  mapSourceRun,
  mapTarget,
  mapTargetProduct,
  type DatabaseRow,
} from "./row-mappers.js";

function text(row: DatabaseRow, key: string): string {
  return String(row[key]);
}

function nullableText(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function timestamp(row: DatabaseRow, key: string): string {
  const value = row[key];
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableTimestamp(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined
    ? null
    : value instanceof Date ? value.toISOString() : String(value);
}

function mapPart(row: DatabaseRow): ProductPartSummaryRecord {
  return {
    id: text(row, "id"),
    partKey: text(row, "part_key"),
    contentHash: text(row, "content_hash"),
    sourceUpdatedAt: nullableTimestamp(row, "source_updated_at"),
    fetchedAt: timestamp(row, "fetched_at"),
    adapterVersion: text(row, "adapter_version"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
    rawPayload: row.raw_payload as ProductPartSummaryRecord["rawPayload"],
    parsedPayload: row.parsed_payload as ProductPartSummaryRecord["parsedPayload"],
  };
}

function mapOperation(row: DatabaseRow): ProductOperationExecutionRecord {
  return {
    id: text(row, "id"),
    attemptId: text(row, "attempt_id"),
    sourceProductId: text(row, "source_product_id"),
    operationCode: text(row, "operation_code"),
    operationName: text(row, "operation_name"),
    operationVersion: text(row, "operation_version"),
    sequence: Number(row.sequence),
    status: row.status as ProductOperationExecutionRecord["status"],
    startedAt: timestamp(row, "started_at"),
    finishedAt: nullableTimestamp(row, "finished_at"),
    error: nullableText(row, "error"),
    outputData: (row.output_data ?? null) as ProductOperationExecutionRecord["outputData"],
  };
}

function mapAttempt(row: DatabaseRow): ProductProcessingAttemptRecord {
  return {
    attemptId: text(row, "attempt_id"), sourceProductId: text(row, "source_product_id"),
    processorVersion: text(row, "processor_version"), status: row.status as ProductProcessingAttemptRecord["status"],
    processorOutput: row.processor_output as ProductProcessingAttemptRecord["processorOutput"],
    operationsOutput: (row.operations_output ?? null) as ProductProcessingAttemptRecord["operationsOutput"],
    classifiedOutput: (row.classified_output ?? null) as ProductProcessingAttemptRecord["classifiedOutput"],
    startedAt: timestamp(row, "started_at"), finishedAt: nullableTimestamp(row, "finished_at"), error: nullableText(row, "error"),
  };
}

function mapSnapshot(row: DatabaseRow): ProductSnapshotListItem {
  return {
    id: text(row, "id"), targetId: text(row, "target_id"), targetCode: text(row, "target_code"),
    targetName: text(row, "target_name"), sourceProductId: text(row, "source_product_id"),
    sourceCode: text(row, "source_code"), sourceExternalId: text(row, "source_external_id"),
    externalId: text(row, "external_id"), title: nullableText(row, "title"),
    fetchedAt: timestamp(row, "fetched_at"), payload: row.payload as JsonObject,
  };
}

function mapClassification(row: DatabaseRow): ProductClassificationObservationRecord {
  return {
    id: text(row, "id"),
    candidateKey: text(row, "candidate_key"),
    typeCode: text(row, "type_code"),
    typeName: text(row, "type_name"),
    scope: text(row, "scope"),
    sourceValue: text(row, "source_value"),
    context: row.context as JsonObject,
    evidence: row.evidence as JsonObject,
    status: row.status as ProductClassificationObservationRecord["status"],
    issueReason: nullableText(row, "issue_reason") as ProductClassificationObservationRecord["issueReason"],
    resolvedReferenceValueId: nullableText(row, "resolved_reference_value_id"),
    resolvedReferenceName: nullableText(row, "resolved_reference_name"),
    firstSeenAt: timestamp(row, "first_seen_at"),
    lastSeenAt: timestamp(row, "last_seen_at"),
  };
}

function mapTargetSnapshot(row: DatabaseRow): ProductTargetSnapshotRecord {
  const target = row.target as DatabaseRow;
  const product = row.product as DatabaseRow | null;
  return {
    target: mapTarget(target),
    product: product === null ? null : mapTargetProduct(product),
  };
}

export class PostgresProductAdminRepository implements ProductAdminRepository {
  constructor(private readonly pool: SqlPool) {}

  async getById(sourceProductId: string): Promise<ProductAdminReadModel | null> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      transactionOpen = true;
      const productResult = await client.query<DatabaseRow>(
        "SELECT * FROM source_products WHERE id = $1",
        [sourceProductId],
      );
      const productRow = productResult.rows[0];
      if (productRow === undefined) {
        await client.query("COMMIT");
        transactionOpen = false;
        return null;
      }
      const sourceProduct = mapSourceProduct(productRow);

      const sourceResult = await client.query<DatabaseRow>(
        "SELECT * FROM sources WHERE id = $1",
        [sourceProduct.sourceId],
      );
      const runResult = sourceProduct.lastSeenRunId === null
        ? { rows: [] as DatabaseRow[] }
        : await client.query<DatabaseRow>(
            "SELECT * FROM source_collection_runs WHERE id = $1",
            [sourceProduct.lastSeenRunId],
          );
      const internalResult = await client.query<DatabaseRow>(
        "SELECT * FROM internal_products WHERE source_product_id = $1",
        [sourceProductId],
      );
      const partsResult = await client.query<DatabaseRow>(
        `SELECT id, part_key, content_hash, source_updated_at, fetched_at,
                adapter_version, created_at, updated_at, raw_payload, parsed_payload
         FROM source_product_parts
         WHERE source_product_id = $1
         ORDER BY part_key`,
        [sourceProductId],
      );
      const operationsResult = await client.query<DatabaseRow>(
        `SELECT *
         FROM product_operation_executions
         WHERE source_product_id = $1
         ORDER BY started_at DESC, attempt_id, sequence
         LIMIT 200`,
        [sourceProductId],
      );
      const attemptsResult = await client.query<DatabaseRow>(
        `SELECT * FROM product_processing_attempts
         WHERE source_product_id = $1 ORDER BY started_at DESC LIMIT 30`,
        [sourceProductId],
      );
      const classificationsResult = await client.query<DatabaseRow>(
        `SELECT observation.*, type.code AS type_code, type.name AS type_name,
                value.name AS resolved_reference_name
         FROM source_reference_observations observation
         JOIN reference_types type ON type.id = observation.reference_type_id
         LEFT JOIN reference_values value ON value.id = observation.resolved_reference_value_id
         WHERE observation.source_product_id = $1 AND observation.active = TRUE
         ORDER BY type.name, observation.source_value, observation.id`,
        [sourceProductId],
      );
      const sourceRow = sourceResult.rows[0];
      if (sourceRow === undefined) throw new Error(`Source ${sourceProduct.sourceId} is missing`);
      const internalRow = internalResult.rows[0];
      const internalProduct = internalRow === undefined ? null : mapInternalProduct(internalRow);

      const jobsResult = await client.query<DatabaseRow>(
        `SELECT *
         FROM jobs
         WHERE (job_type IN ('collect_product', 'process_product') AND payload->>'sourceProductId' = $1)
            OR (job_type = 'export_product' AND payload->>'internalProductId' = $2::TEXT)
         ORDER BY created_at DESC, id DESC
         LIMIT 100`,
        [sourceProductId, internalProduct?.id ?? null],
      );
      const targetsResult = await client.query<DatabaseRow>(
        `SELECT ROW_TO_JSON(target.*) AS target, ROW_TO_JSON(product.*) AS product
         FROM targets target
         LEFT JOIN target_products product
           ON product.target_id = target.id
          AND product.internal_product_id = $1::BIGINT
         WHERE target.enabled = TRUE OR target.exporter_code = 'wordpress' OR product.id IS NOT NULL
         ORDER BY target.name, target.id`,
        [internalProduct?.id ?? null],
      );
      const snapshotsResult = await client.query<DatabaseRow>(
        `SELECT snapshot.*, target.code AS target_code, target.name AS target_name,
                source.code AS source_code,
                NULLIF(snapshot.payload->'product'->>'title', '') AS title
         FROM target_product_snapshots snapshot
         JOIN targets target ON target.id = snapshot.target_id
         JOIN source_products product ON product.id = snapshot.source_product_id
         JOIN sources source ON source.id = product.source_id
         WHERE snapshot.source_product_id = $1 ORDER BY snapshot.fetched_at DESC`,
        [sourceProductId],
      );

      const result: ProductAdminReadModel = {
        source: mapSource(sourceRow),
        sourceProduct,
        lastCollectionRun: runResult.rows[0] === undefined ? null : mapSourceRun(runResult.rows[0]),
        internalProduct,
        parts: partsResult.rows.map(mapPart),
        operations: operationsResult.rows.map(mapOperation),
        processingAttempts: attemptsResult.rows.map(mapAttempt),
        classifications: classificationsResult.rows.map(mapClassification),
        jobs: jobsResult.rows.map(mapJob),
        targets: targetsResult.rows.map(mapTargetSnapshot),
        snapshots: snapshotsResult.rows.map(mapSnapshot),
      };
      await client.query("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listProducts(query: ProductListQuery): Promise<ProductListResult> {
    const client = await this.pool.connect();
    try {
    const parameters: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown): string => { parameters.push(value); return `$${parameters.length}`; };
    if (query.search) {
      const p = add(`%${query.search}%`);
      where.push(`(product.id::TEXT ILIKE ${p} OR product.source_key ILIKE ${p} OR COALESCE(product.external_id, '') ILIKE ${p} OR COALESCE(internal.data->>'title', product.discovery_metadata->>'title', '') ILIKE ${p})`);
    }
    if (query.sourceCode) where.push(`source.code = ${add(query.sourceCode)}`);
    const stageSql = `CASE WHEN parts.collected_at IS NULL THEN 'discovered' WHEN internal.id IS NULL THEN 'collected' WHEN internal.status = 'classification_pending' THEN 'classification_pending' WHEN internal.status = 'classified' THEN 'classified' ELSE internal.status END`;
    const classificationSql = `CASE WHEN internal.id IS NULL THEN 'not_processed' WHEN internal.status = 'classification_pending' THEN 'pending' WHEN internal.data->'classification'->>'status' = 'complete' THEN 'complete' ELSE 'pending' END`;
    if (query.stage) where.push(`${stageSql} = ${add(query.stage)}`);
    if (query.classificationStatus) where.push(`${classificationSql} = ${add(query.classificationStatus)}`);
    if (query.targetStatus) where.push(`COALESCE(target_state.status, 'not_exported') = ${add(query.targetStatus)}`);
    const filter = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const from = `FROM source_products product
      JOIN sources source ON source.id = product.source_id
      LEFT JOIN internal_products internal ON internal.source_product_id = product.id
      LEFT JOIN LATERAL (SELECT MAX(fetched_at) AS collected_at FROM source_product_parts WHERE source_product_id = product.id) parts ON TRUE
      LEFT JOIN LATERAL (
        SELECT tp.status, tp.external_id FROM target_products tp
        JOIN targets t ON t.id = tp.target_id
        WHERE tp.internal_product_id = internal.id ORDER BY (t.code = 'slamdunk') DESC, tp.updated_at DESC LIMIT 1
      ) target_state ON TRUE`;
    const countResult = await client.query<DatabaseRow>(`SELECT COUNT(*) AS total ${from} ${filter}`, parameters);
    const limit = add(query.limit); const offset = add(query.offset);
    const result = await client.query<DatabaseRow>(
      `SELECT product.id AS source_product_id, source.id AS source_id, source.code AS source_code,
              source.name AS source_name, product.source_key, product.external_id,
              NULLIF(COALESCE(internal.data->>'title', product.discovery_metadata->>'title'), '') AS title,
              product.status AS source_status, ${stageSql} AS stage, ${classificationSql} AS classification_status,
              parts.collected_at, internal.processed_at, COALESCE(target_state.status, 'not_exported') AS target_status,
              target_state.external_id AS target_external_id,
              EXISTS (SELECT 1 FROM target_product_snapshots snapshot WHERE snapshot.source_product_id = product.id) AS has_target_snapshot
       ${from} ${filter} ORDER BY product.updated_at DESC, product.id DESC LIMIT ${limit} OFFSET ${offset}`,
      parameters,
    );
    const sources = await client.query<DatabaseRow>("SELECT code, name FROM sources ORDER BY name, id");
    return {
      total: Number(countResult.rows[0]?.total ?? 0),
      sources: sources.rows.map((row) => ({ code: text(row, "code"), name: text(row, "name") })),
      items: result.rows.map((row) => ({
        sourceProductId: text(row, "source_product_id"), sourceId: text(row, "source_id"), sourceCode: text(row, "source_code"), sourceName: text(row, "source_name"),
        sourceKey: text(row, "source_key"), externalId: nullableText(row, "external_id"), title: nullableText(row, "title"), sourceStatus: text(row, "source_status"),
        stage: text(row, "stage"), classificationStatus: text(row, "classification_status"), collectedAt: nullableTimestamp(row, "collected_at"), processedAt: nullableTimestamp(row, "processed_at"),
        targetStatus: text(row, "target_status"), targetExternalId: nullableText(row, "target_external_id"), hasTargetSnapshot: row.has_target_snapshot === true,
      })),
    };
    } finally { client.release(); }
  }

  async listSnapshots(query: ProductSnapshotListQuery): Promise<ProductSnapshotListResult> {
    const client = await this.pool.connect();
    try {
    const parameters: unknown[] = [];
    const filter = query.search ? `WHERE snapshot.external_id ILIKE $1 OR snapshot.source_external_id ILIKE $1 OR snapshot.source_product_id::TEXT ILIKE $1 OR COALESCE(snapshot.payload->'product'->>'title', '') ILIKE $1` : "";
    if (query.search) parameters.push(`%${query.search}%`);
    const from = `FROM target_product_snapshots snapshot JOIN targets target ON target.id = snapshot.target_id JOIN source_products product ON product.id = snapshot.source_product_id JOIN sources source ON source.id = product.source_id ${filter}`;
    const count = await client.query<DatabaseRow>(`SELECT COUNT(*) AS total ${from}`, parameters);
    parameters.push(query.limit, query.offset);
    const result = await client.query<DatabaseRow>(
      `SELECT snapshot.*, target.code AS target_code, target.name AS target_name, source.code AS source_code,
              NULLIF(snapshot.payload->'product'->>'title', '') AS title ${from}
       ORDER BY snapshot.fetched_at DESC, snapshot.id DESC LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    );
    return { total: Number(count.rows[0]?.total ?? 0), items: result.rows.map(mapSnapshot) };
    } finally { client.release(); }
  }
}
