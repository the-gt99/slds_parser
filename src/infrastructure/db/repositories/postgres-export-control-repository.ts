import type { EntityId, JsonObject } from "../../../contracts/index.js";
import { IntegrationContractError } from "../../../core/errors/index.js";
import type {
  ExportControlBatchItemRecord,
  ExportControlBatchRecord,
  ExportControlExportCandidate,
  ExportControlFilter,
  ExportControlListItem,
  ExportControlListQuery,
  ExportControlListResult,
  ExportControlPreflightCandidate,
  ExportControlRepository,
  SaveExportControlPreflightInput,
} from "../../../repositories/index.js";
import type { SqlClient, SqlPool } from "../sql-executor.js";
import type { DatabaseRow } from "./row-mappers.js";

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
  return value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);
}

function flags(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

const effectiveStatusSql = `CASE
  WHEN review.status = 'checking' THEN 'checking'
  WHEN review.status = 'stale'
    OR review.configuration_revision <> revision.revision THEN 'stale'
  ELSE review.status
END`;

function filterSql(
  filter: ExportControlFilter,
  add: (value: unknown) => string,
  options: { readonly includeStatus: boolean },
): string[] {
  const where: string[] = [];
  if (options.includeStatus && filter.status !== undefined) {
    if (filter.status === "stale") {
      where.push("(review.status = 'stale' OR (review.status <> 'checking' AND review.configuration_revision <> revision.revision))");
    } else if (filter.status === "checking") {
      where.push("review.status = 'checking'");
    } else {
      where.push(`review.status = ${add(filter.status)} AND review.configuration_revision = revision.revision`);
    }
  }
  if (filter.operation === "create") where.push("review.will_create = TRUE");
  if (filter.operation === "update") where.push("review.will_create = FALSE");
  if (filter.riskLevel !== undefined) where.push(`review.risk_level = ${add(filter.riskLevel)}`);
  if (filter.changeFlag !== undefined) where.push(`review.change_flags @> ARRAY[${add(filter.changeFlag)}]::TEXT[]`);
  if (filter.search !== undefined) {
    const search = filter.search.trim();
    if (/^\d+$/u.test(search)) {
      const value = add(search);
      where.push(`(review.source_product_id = ${value}::BIGINT OR review.source_external_id = ${value})`);
    } else {
      where.push(`review.search_text ILIKE ${add(`%${search}%`)}`);
    }
  }
  return where;
}

function mapListItem(row: DatabaseRow): ExportControlListItem {
  const lastJobId = nullableText(row, "last_job_id");
  return {
    id: text(row, "id"),
    targetId: text(row, "target_id"),
    targetName: text(row, "target_name"),
    targetEnabled: row.target_enabled === true,
    sourceProductId: text(row, "source_product_id"),
    internalProductId: text(row, "internal_product_id"),
    sourceCode: text(row, "source_code"),
    sourceExternalId: nullableText(row, "source_external_id"),
    title: text(row, "title"),
    imageUrl: nullableText(row, "image_url"),
    status: text(row, "effective_status") as ExportControlListItem["status"],
    phase: text(row, "phase"),
    payloadHash: nullableText(row, "payload_hash"),
    externalId: nullableText(row, "external_id"),
    willCreate: row.will_create === null || row.will_create === undefined ? null : row.will_create === true,
    matchedBy: nullableText(row, "matched_by"),
    riskLevel: text(row, "risk_level") as ExportControlListItem["riskLevel"],
    changeFlags: flags(row.change_flags),
    fieldChangeCount: Number(row.field_change_count),
    taxonomyAddedCount: Number(row.taxonomy_added_count),
    taxonomyRemovedCount: Number(row.taxonomy_removed_count),
    imageChangeCount: Number(row.image_change_count),
    variationChangeCount: Number(row.variation_change_count),
    deactivatedVariationCount: Number(row.deactivated_variation_count),
    blockers: row.blockers as ExportControlListItem["blockers"],
    changeSummary: row.change_summary as JsonObject,
    error: nullableText(row, "error"),
    checkedAt: timestamp(row, "checked_at"),
    lastExportJob: lastJobId === null ? null : {
      id: lastJobId,
      status: text(row, "last_job_status") as NonNullable<ExportControlListItem["lastExportJob"]>["status"],
      createdAt: timestamp(row, "last_job_created_at"),
      finishedAt: nullableTimestamp(row, "last_job_finished_at"),
      lastError: nullableText(row, "last_job_error"),
    },
    targetProductStatus: nullableText(row, "target_product_status"),
    targetProductExternalId: nullableText(row, "target_product_external_id"),
  };
}

async function transaction<Result>(pool: SqlPool, callback: (client: SqlClient) => Promise<Result>): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

async function queryPool<Row extends Record<string, unknown> = DatabaseRow>(
  pool: SqlPool,
  sql: string,
  parameters: unknown[] = [],
): Promise<{ readonly rows: readonly Row[] }> {
  const client = await pool.connect();
  try { return await client.query<Row>(sql, parameters); } finally { client.release(); }
}

export class PostgresExportControlRepository implements ExportControlRepository {
  constructor(private readonly pool: SqlPool) {}

  async list(query: ExportControlListQuery): Promise<ExportControlListResult> {
    const parameters: unknown[] = [];
    const add = (value: unknown): string => { parameters.push(value); return `$${parameters.length}`; };
    const where = [`review.target_id = ${add(query.targetId)}`];
    where.push(...filterSql(query, add, { includeStatus: true }));
    if (query.cursor !== undefined) {
      where.push(`(review.checked_at, review.id) < (${add(query.cursor.checkedAt)}::TIMESTAMPTZ, ${add(query.cursor.id)}::BIGINT)`);
    }
    const pageLimit = add(query.limit + 1);
    const result = await queryPool<DatabaseRow>(this.pool,
      `WITH page AS MATERIALIZED (
         SELECT review.id, ${effectiveStatusSql} AS effective_status
         FROM target_product_preflight_reviews review
         JOIN target_export_revisions revision ON revision.target_id = review.target_id
         WHERE ${where.join(" AND ")}
         ORDER BY review.checked_at DESC, review.id DESC
         LIMIT ${pageLimit}
       )
       SELECT review.*, page.effective_status,
              target.name AS target_name, target.enabled AS target_enabled,
              last_job.id AS last_job_id, last_job.status AS last_job_status,
              last_job.created_at AS last_job_created_at,
              last_job.finished_at AS last_job_finished_at,
              last_job.last_error AS last_job_error,
              target_product.status AS target_product_status,
              target_product.external_id AS target_product_external_id
       FROM page
       JOIN target_product_preflight_reviews review ON review.id = page.id
       JOIN targets target ON target.id = review.target_id
       LEFT JOIN target_products target_product
         ON target_product.target_id = review.target_id
        AND target_product.internal_product_id = review.internal_product_id
       LEFT JOIN LATERAL (
         SELECT job.id, job.status, job.created_at, job.finished_at, job.last_error
         FROM jobs job
         WHERE job.job_type = 'export_product'
           AND job.payload->>'targetId' = review.target_id::TEXT
           AND job.payload->>'internalProductId' = review.internal_product_id::TEXT
         ORDER BY job.created_at DESC, job.id DESC
         LIMIT 1
       ) last_job ON TRUE
       ORDER BY review.checked_at DESC, review.id DESC`,
      parameters,
    );
    const hasMore = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(mapListItem),
      nextCursor: hasMore && last !== undefined
        ? { checkedAt: timestamp(last, "checked_at"), id: text(last, "id") }
        : null,
    };
  }

  async preparePreflightCandidates(input: {
    readonly targetId: EntityId;
    readonly sourceProductIds?: readonly EntityId[];
    readonly limit: number;
  }): Promise<readonly ExportControlPreflightCandidate[]> {
    return transaction(this.pool, async (client) => {
      const explicit = input.sourceProductIds !== undefined;
      const result = await client.query<DatabaseRow>(
        `WITH selected AS MATERIALIZED (
           SELECT internal.id AS internal_product_id, internal.source_product_id,
                  internal.content_hash, internal.data, internal.updated_at,
                  source.code AS source_code, source_product.external_id AS source_external_id,
                  COALESCE(NULLIF(internal.data->>'title', ''), source_product.source_key) AS title,
                  NULLIF(internal.data->'images'->0->>'url', '') AS image_url,
                  revision.revision AS configuration_revision
           FROM internal_products internal
           JOIN source_products source_product ON source_product.id = internal.source_product_id
           JOIN sources source ON source.id = source_product.source_id
           JOIN target_export_revisions revision ON revision.target_id = $1
           LEFT JOIN target_product_preflight_reviews review
             ON review.target_id = $1 AND review.internal_product_id = internal.id
           WHERE internal.status = 'classified'
             AND internal.data->'classification'->>'status' = 'complete'
             AND ($2::BIGINT[] IS NULL OR internal.source_product_id = ANY($2::BIGINT[]))
             AND NOT EXISTS (
               SELECT 1 FROM jobs job
               WHERE job.job_type = 'preflight_product'
                 AND job.status IN ('pending', 'running', 'retry')
                 AND job.payload->>'targetId' = $1::TEXT
                 AND job.payload->>'sourceProductId' = internal.source_product_id::TEXT
             )
             AND CASE WHEN $3::BOOLEAN THEN COALESCE(review.status, '') <> 'checking'
               ELSE review.id IS NULL OR review.status IN ('stale', 'error')
                 OR review.configuration_revision <> revision.revision
             END
           ORDER BY CASE WHEN $2::BIGINT[] IS NULL THEN 0 ELSE ARRAY_POSITION($2::BIGINT[], internal.source_product_id) END,
                    internal.updated_at DESC, internal.id DESC
           LIMIT $4
           FOR UPDATE OF internal SKIP LOCKED
         ), marked AS (
           INSERT INTO target_product_preflight_reviews (
             target_id, internal_product_id, source_product_id, source_code,
             source_external_id, title, image_url, search_text, status, phase,
             internal_content_hash, configuration_revision, checked_at, updated_at
           )
           SELECT $1, selected.internal_product_id, selected.source_product_id,
                  selected.source_code, selected.source_external_id, selected.title,
                  selected.image_url,
                  CONCAT_WS(' ', selected.source_product_id::TEXT, selected.source_external_id, selected.title),
                  'checking', 'preflight', selected.content_hash,
                  selected.configuration_revision, NOW(), NOW()
           FROM selected
           ON CONFLICT (target_id, internal_product_id) DO UPDATE
           SET source_external_id = EXCLUDED.source_external_id,
               title = EXCLUDED.title,
               image_url = EXCLUDED.image_url,
               search_text = EXCLUDED.search_text,
               status = 'checking', phase = 'preflight', error = NULL,
               internal_content_hash = EXCLUDED.internal_content_hash,
               configuration_revision = EXCLUDED.configuration_revision,
               checked_at = NOW(), updated_at = NOW()
           RETURNING source_product_id, internal_product_id
         )
         SELECT * FROM marked`,
        [input.targetId, input.sourceProductIds ?? null, explicit, input.limit],
      );
      return result.rows.map((row) => ({
        sourceProductId: text(row, "source_product_id"),
        internalProductId: text(row, "internal_product_id"),
      }));
    });
  }

  async savePreflight(input: SaveExportControlPreflightInput): Promise<void> {
    await transaction(this.pool, async (client) => {
      const current = await client.query<DatabaseRow>(
        `SELECT id FROM internal_products
         WHERE id = $1 AND content_hash = $2
         FOR SHARE`,
        [input.internalProductId, input.internalContentHash],
      );
      if (current.rows.length === 0) {
        await client.query(
          `UPDATE target_product_preflight_reviews
           SET status = 'stale', updated_at = NOW()
           WHERE target_id = $1 AND internal_product_id = $2`,
          [input.targetId, input.internalProductId],
        );
        return;
      }
      await client.query(
      `INSERT INTO target_product_preflight_reviews (
         target_id, internal_product_id, source_product_id, source_code,
         source_external_id, title, image_url, search_text, status, phase,
         internal_content_hash, configuration_revision, payload_hash, external_id,
         will_create, matched_by, risk_level, change_flags, field_change_count,
         taxonomy_added_count, taxonomy_removed_count, image_change_count,
         variation_change_count, deactivated_variation_count, blockers,
         change_summary, error, checked_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, CONCAT_WS(' ', $3::TEXT, $5, $6), $8, $9,
         $10, $11::BIGINT, $12, $13, $14, $15, $16, $17::TEXT[], $18, $19,
         $20, $21, $22, $23, $24::JSONB, $25::JSONB, $26, NOW(), NOW()
       )
       ON CONFLICT (target_id, internal_product_id) DO UPDATE SET
         source_product_id = EXCLUDED.source_product_id,
         source_code = EXCLUDED.source_code,
         source_external_id = EXCLUDED.source_external_id,
         title = EXCLUDED.title,
         image_url = EXCLUDED.image_url,
         search_text = EXCLUDED.search_text,
         status = EXCLUDED.status,
         phase = EXCLUDED.phase,
         internal_content_hash = EXCLUDED.internal_content_hash,
         configuration_revision = EXCLUDED.configuration_revision,
         payload_hash = EXCLUDED.payload_hash,
         external_id = EXCLUDED.external_id,
         will_create = EXCLUDED.will_create,
         matched_by = EXCLUDED.matched_by,
         risk_level = EXCLUDED.risk_level,
         change_flags = EXCLUDED.change_flags,
         field_change_count = EXCLUDED.field_change_count,
         taxonomy_added_count = EXCLUDED.taxonomy_added_count,
         taxonomy_removed_count = EXCLUDED.taxonomy_removed_count,
         image_change_count = EXCLUDED.image_change_count,
         variation_change_count = EXCLUDED.variation_change_count,
         deactivated_variation_count = EXCLUDED.deactivated_variation_count,
         blockers = EXCLUDED.blockers,
         change_summary = EXCLUDED.change_summary,
         error = EXCLUDED.error,
         checked_at = NOW(), updated_at = NOW()`,
      [
        input.targetId, input.internalProductId, input.sourceProductId, input.sourceCode,
        input.sourceExternalId, input.title, input.imageUrl, input.status, input.phase,
        input.internalContentHash, input.configurationRevision, input.payloadHash,
        input.externalId, input.willCreate, input.matchedBy, input.riskLevel,
        input.changeFlags, input.fieldChangeCount, input.taxonomyAddedCount,
        input.taxonomyRemovedCount, input.imageChangeCount, input.variationChangeCount,
        input.deactivatedVariationCount, JSON.stringify(input.blockers),
        JSON.stringify(input.changeSummary), input.error ?? null,
      ],
      );
    });
  }

  async savePreflightError(input: { readonly targetId: EntityId; readonly sourceProductId: EntityId; readonly error: string }): Promise<void> {
    await queryPool(this.pool,
      `UPDATE target_product_preflight_reviews
       SET status = 'error', phase = 'preflight', error = $3,
           checked_at = NOW(), updated_at = NOW()
       WHERE target_id = $1 AND source_product_id = $2`,
      [input.targetId, input.sourceProductId, input.error],
    );
  }

  async listExportCandidates(input: {
    readonly targetId: EntityId;
    readonly sourceProductIds?: readonly EntityId[];
    readonly filter?: ExportControlFilter;
    readonly limit: number;
  }): Promise<readonly ExportControlExportCandidate[]> {
    if (input.filter?.status !== undefined && input.filter.status !== "ready") return [];
    const parameters: unknown[] = [];
    const add = (value: unknown): string => { parameters.push(value); return `$${parameters.length}`; };
    const where = [
      `review.target_id = ${add(input.targetId)}`,
      "review.status = 'ready'",
      "review.configuration_revision = revision.revision",
      "review.payload_hash IS NOT NULL",
      "NOT EXISTS (SELECT 1 FROM jobs active_job WHERE active_job.job_type = 'export_product' AND active_job.status IN ('pending', 'running', 'retry') AND active_job.payload->>'targetId' = review.target_id::TEXT AND active_job.payload->>'internalProductId' = review.internal_product_id::TEXT)",
    ];
    if (input.sourceProductIds !== undefined) where.push(`review.source_product_id = ANY(${add(input.sourceProductIds)}::BIGINT[])`);
    where.push(...filterSql(input.filter ?? {}, add, { includeStatus: false }));
    const limit = add(input.limit);
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT review.id, review.source_product_id, review.internal_product_id,
              review.payload_hash, review.will_create, review.external_id,
              review.matched_by, review.risk_level, review.change_flags
       FROM target_product_preflight_reviews review
       JOIN target_export_revisions revision ON revision.target_id = review.target_id
       WHERE ${where.join(" AND ")}
       ORDER BY review.checked_at DESC, review.id DESC
       LIMIT ${limit}`,
      parameters,
    );
    return result.rows.map((row) => ({
      reviewId: text(row, "id"),
      sourceProductId: text(row, "source_product_id"),
      internalProductId: text(row, "internal_product_id"),
      payloadHash: text(row, "payload_hash"),
      willCreate: row.will_create === true,
      externalId: nullableText(row, "external_id"),
      matchedBy: nullableText(row, "matched_by"),
      riskLevel: text(row, "risk_level") as ExportControlExportCandidate["riskLevel"],
      changeFlags: flags(row.change_flags),
    }));
  }

  async createBatch(input: {
    readonly targetId: EntityId;
    readonly filter: JsonObject;
    readonly actor: string;
    readonly reason?: string;
    readonly candidates: readonly ExportControlExportCandidate[];
  }): Promise<{
    readonly batchId: EntityId;
    readonly items: readonly ExportControlBatchItemRecord[];
    readonly jobIds: readonly EntityId[];
  }> {
    if (input.candidates.length === 0) throw new IntegrationContractError("Нет готовых товаров для экспорта");
    return transaction(this.pool, async (client) => {
      const batch = await client.query<DatabaseRow>(
        `INSERT INTO target_export_batches (target_id, filter, actor, reason)
         VALUES ($1, $2::JSONB, $3, $4) RETURNING id`,
        [input.targetId, JSON.stringify(input.filter), input.actor, input.reason ?? null],
      );
      const batchId = text(batch.rows[0]!, "id");
      const reviewIds = input.candidates.map((item) => item.reviewId);
      const payloadHashes = input.candidates.map((item) => item.payloadHash);
      const items = await client.query<DatabaseRow>(
        `WITH requested AS (
           SELECT * FROM UNNEST($3::BIGINT[], $4::TEXT[]) AS item(review_id, payload_hash)
         )
         INSERT INTO target_export_batch_items (
           batch_id, target_id, preflight_review_id, source_product_id,
           internal_product_id, approved_payload_hash, approved_will_create,
           approved_external_id, approved_matched_by
         )
         SELECT $1, $2, review.id, review.source_product_id,
                review.internal_product_id, review.payload_hash, review.will_create,
                review.external_id, review.matched_by
         FROM requested
         JOIN target_product_preflight_reviews review
           ON review.id = requested.review_id
          AND review.payload_hash = requested.payload_hash
          AND review.target_id = $2
          AND review.status = 'ready'
         JOIN target_export_revisions revision
           ON revision.target_id = review.target_id
          AND revision.revision = review.configuration_revision
         JOIN internal_products internal
           ON internal.id = review.internal_product_id
          AND internal.content_hash = review.internal_content_hash
         WHERE NOT EXISTS (
           SELECT 1 FROM jobs active_job
           WHERE active_job.job_type = 'export_product'
             AND active_job.status IN ('pending', 'running', 'retry')
             AND active_job.payload->>'targetId' = review.target_id::TEXT
             AND active_job.payload->>'internalProductId' = review.internal_product_id::TEXT
         )
         RETURNING id, source_product_id, internal_product_id`,
        [batchId, input.targetId, reviewIds, payloadHashes],
      );
      if (items.rows.length !== input.candidates.length) {
        throw new IntegrationContractError("Состав готовых товаров изменился; обновите список и повторите экспорт");
      }
      const candidateByInternalId = new Map(input.candidates.map((candidate) => [candidate.internalProductId, candidate]));
      const requestedJobs = items.rows.map((row) => {
        const internalProductId = text(row, "internal_product_id");
        const candidate = candidateByInternalId.get(internalProductId)!;
        const batchItemId = text(row, "id");
        return {
          batch_item_id: batchItemId,
          unique_key: `target-product:${input.targetId}:${internalProductId}:export`,
          payload: {
            internalProductId,
            targetId: input.targetId,
            force: false,
            batchItemId,
            approval: {
              preflightReviewId: candidate.reviewId,
              payloadHash: candidate.payloadHash,
              willCreate: candidate.willCreate,
              externalId: candidate.externalId,
              matchedBy: candidate.matchedBy,
            },
          },
        };
      });
      let jobs;
      try {
        jobs = await client.query<DatabaseRow>(
          `WITH requested AS MATERIALIZED (
             SELECT *
             FROM JSONB_TO_RECORDSET($1::JSONB) AS row(
               batch_item_id BIGINT,
               unique_key TEXT,
               payload JSONB
             )
           ), inserted AS (
             INSERT INTO jobs (job_type, payload, status, available_at, unique_key)
             SELECT 'export_product', requested.payload, 'pending', NOW(), requested.unique_key
             FROM requested
             RETURNING id, unique_key
           )
           UPDATE target_export_batch_items item
           SET job_id = inserted.id
           FROM requested
           JOIN inserted ON inserted.unique_key = requested.unique_key
           WHERE item.id = requested.batch_item_id
           RETURNING inserted.id AS job_id`,
          [JSON.stringify(requestedJobs)],
        );
      } catch (error) {
        if (error !== null && typeof error === "object" && "code" in error && error.code === "23505") {
          throw new IntegrationContractError("Один из товаров уже поставлен на экспорт; обновите список и повторите запуск", { cause: error });
        }
        throw error;
      }
      if (jobs.rows.length !== items.rows.length) {
        throw new IntegrationContractError("Не удалось атомарно поставить всю партию на экспорт");
      }
      return {
        batchId,
        items: items.rows.map((row) => ({
          id: text(row, "id"),
          sourceProductId: text(row, "source_product_id"),
          internalProductId: text(row, "internal_product_id"),
        })),
        jobIds: jobs.rows.map((row) => text(row, "job_id")),
      };
    });
  }

  async listBatches(targetId: EntityId, limit: number): Promise<readonly ExportControlBatchRecord[]> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `WITH selected AS MATERIALIZED (
         SELECT * FROM target_export_batches
         WHERE target_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       )
       SELECT selected.*,
              COUNT(item.id)::INT AS item_count,
              COUNT(item.id) FILTER (WHERE job.status IN ('pending', 'retry'))::INT AS pending_count,
              COUNT(item.id) FILTER (WHERE job.status = 'running')::INT AS running_count,
              COUNT(item.id) FILTER (WHERE job.status = 'completed')::INT AS completed_count,
              COUNT(item.id) FILTER (WHERE job.status = 'failed')::INT AS failed_count
       FROM selected
       LEFT JOIN target_export_batch_items item ON item.batch_id = selected.id
       LEFT JOIN jobs job ON job.id = item.job_id
       GROUP BY selected.id, selected.target_id, selected.filter, selected.actor,
                selected.reason, selected.created_at
       ORDER BY selected.created_at DESC, selected.id DESC`,
      [targetId, limit],
    );
    return result.rows.map((row) => ({
      id: text(row, "id"), targetId: text(row, "target_id"), actor: text(row, "actor"),
      reason: nullableText(row, "reason"), createdAt: timestamp(row, "created_at"),
      itemCount: Number(row.item_count), pendingCount: Number(row.pending_count),
      runningCount: Number(row.running_count), completedCount: Number(row.completed_count),
      failedCount: Number(row.failed_count),
    }));
  }
}
