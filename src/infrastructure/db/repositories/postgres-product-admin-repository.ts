import type { JsonObject } from "../../../contracts/index.js";
import type {
  ProductAdminReadModel,
  ProductAdminRepository,
  ProductClassificationObservationRecord,
  ProductOperationExecutionRecord,
  ProductPartSummaryRecord,
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
                adapter_version, created_at, updated_at
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
         WHERE target.enabled = TRUE OR product.id IS NOT NULL
         ORDER BY target.name, target.id`,
        [internalProduct?.id ?? null],
      );

      const result: ProductAdminReadModel = {
        source: mapSource(sourceRow),
        sourceProduct,
        lastCollectionRun: runResult.rows[0] === undefined ? null : mapSourceRun(runResult.rows[0]),
        internalProduct,
        parts: partsResult.rows.map(mapPart),
        operations: operationsResult.rows.map(mapOperation),
        classifications: classificationsResult.rows.map(mapClassification),
        jobs: jobsResult.rows.map(mapJob),
        targets: targetsResult.rows.map(mapTargetSnapshot),
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
}
