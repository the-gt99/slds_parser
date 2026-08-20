import type { EntityId, JsonObject } from "../../../contracts/index.js";
import { IntegrationContractError } from "../../../core/errors/index.js";
import type {
  CachedExportControlPreflight,
  ExportControlBatchItemRecord,
  ExportControlBatchRecord,
  ExportCampaignMode,
  ExportCampaignItemRecord,
  ExportCampaignRecord,
  ExportControlExportCandidate,
  ExportControlFilter,
  ExportControlListItem,
  ExportControlListQuery,
  ExportControlListResult,
  ExportControlPreflightCandidate,
  ExportControlReadinessSummary,
  ExportControlRepository,
  ExportSourceRefreshCandidate,
  ExportSourceRefreshRecord,
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

interface ExportCandidateQuery {
  readonly targetId: EntityId;
  readonly sourceProductIds?: readonly EntityId[];
  readonly filter?: ExportControlFilter;
  readonly limit: number;
  readonly campaignId?: EntityId;
  readonly excludeNoChanges?: boolean;
}

function mapExportCandidate(row: DatabaseRow): ExportControlExportCandidate {
  return {
    reviewId: text(row, "id"),
    sourceProductId: text(row, "source_product_id"),
    internalProductId: text(row, "internal_product_id"),
    payloadHash: text(row, "payload_hash"),
    willCreate: row.will_create === true,
    externalId: nullableText(row, "external_id"),
    matchedBy: nullableText(row, "matched_by"),
    riskLevel: text(row, "risk_level") as ExportControlExportCandidate["riskLevel"],
    changeFlags: flags(row.change_flags),
    wordpressStateHash: nullableText(row, "wordpress_state_hash"),
    ...(row.source_refresh_id === null || row.source_refresh_id === undefined
      ? {}
      : { sourceRefreshId: text(row, "source_refresh_id") }),
  };
}

const campaignCandidatePageSize = 25;

function mapCampaign(row: DatabaseRow): ExportCampaignRecord {
  return {
    id: text(row, "id"),
    targetId: text(row, "target_id"),
    status: text(row, "status") as ExportCampaignRecord["status"],
    actor: text(row, "actor"),
    reason: nullableText(row, "reason"),
    mode: text(row, "mode") as ExportCampaignMode,
    catalogRunId: nullableText(row, "catalog_run_id"),
    preflightWindow: Number(row.preflight_window),
    maxExports: row.max_exports === null || row.max_exports === undefined ? null : Number(row.max_exports),
    itemCount: Number(row.item_count ?? 0),
    pendingCount: Number(row.pending_count ?? 0),
    retryCount: Number(row.retry_count ?? 0),
    runningCount: Number(row.running_count ?? 0),
    completedCount: Number(row.completed_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    acknowledgedFailedCount: Number(row.acknowledged_failed_count ?? 0),
    activePreflightCount: Number(row.active_preflight_count ?? 0),
    scanBeforeInternalProductId: nullableText(row, "scan_before_internal_product_id"),
    scanComplete: row.scan_complete === true,
    lastError: nullableText(row, "last_error"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
    pausedAt: nullableTimestamp(row, "paused_at"),
    completedAt: nullableTimestamp(row, "completed_at"),
  };
}

const campaignProgressSql = `
  SELECT campaign.*,
         COUNT(item.id)::INT AS item_count,
         COUNT(item.id) FILTER (WHERE job.status = 'pending')::INT AS pending_count,
         COUNT(item.id) FILTER (WHERE job.status = 'retry')::INT AS retry_count,
         COUNT(item.id) FILTER (WHERE job.status = 'running')::INT AS running_count,
         COUNT(item.id) FILTER (WHERE job.status = 'completed')::INT AS completed_count,
         COUNT(item.id) FILTER (WHERE job.status = 'failed')::INT AS failed_count,
         (SELECT COUNT(*)::INT FROM jobs preflight
          WHERE preflight.job_type = 'preflight_product'
            AND preflight.status IN ('pending', 'running', 'retry')
            AND preflight.payload->>'targetId' = campaign.target_id::TEXT) AS active_preflight_count
  FROM target_export_campaigns campaign
  LEFT JOIN target_export_batches batch ON batch.campaign_id = campaign.id
  LEFT JOIN target_export_batch_items item ON item.batch_id = batch.id
  LEFT JOIN jobs job ON job.id = item.job_id`;

const effectiveStatusSql = `CASE
  WHEN review.status = 'checking' THEN 'checking'
  WHEN review.status = 'stale'
    OR review.configuration_revision <> revision.revision
    OR review.internal_content_hash <> internal.content_hash THEN 'stale'
  ELSE review.status
END`;

function exportEligibleInternalSql(alias: string): string {
  return `${alias}.status IN ('classified', 'classification_pending')
    AND ${alias}.data->'classification'->>'status' IN ('complete', 'partial')`;
}

function filterSql(
  filter: ExportControlFilter,
  add: (value: unknown) => string,
  options: { readonly includeStatus: boolean },
): string[] {
  const where: string[] = [];
  if (options.includeStatus && filter.status !== undefined) {
    if (filter.status === "stale") {
      where.push("(review.status = 'stale' OR (review.status <> 'checking' AND (review.configuration_revision <> revision.revision OR review.internal_content_hash <> internal.content_hash)))");
    } else if (filter.status === "checking") {
      where.push("review.status = 'checking'");
    } else {
      where.push(`review.status = ${add(filter.status)} AND review.configuration_revision = revision.revision AND review.internal_content_hash = internal.content_hash`);
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
      where.push(`(review.source_product_id = ${value}::BIGINT OR review.source_external_id = ${value}::BIGINT::TEXT)`);
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
    wordpressCheckedAt: nullableTimestamp(row, "wordpress_checked_at"),
    wordpressSnapshotFetchedAt: nullableTimestamp(row, "wordpress_snapshot_fetched_at"),
    usedCachedWordPress: row.used_cached_wordpress === true,
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
         JOIN internal_products internal ON internal.id = review.internal_product_id
         WHERE ${where.join(" AND ")}
         ORDER BY review.checked_at DESC, review.id DESC
         LIMIT ${pageLimit}
       )
       SELECT review.*, page.effective_status,
              snapshot.fetched_at AS wordpress_snapshot_fetched_at,
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
       LEFT JOIN target_product_snapshots snapshot
         ON snapshot.target_id = review.target_id
        AND snapshot.source_product_id = review.source_product_id
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
    const summaryResult = await queryPool<DatabaseRow>(this.pool,
      `WITH eligible AS MATERIALIZED (
         SELECT id, content_hash
         FROM internal_products internal
         WHERE ${exportEligibleInternalSql("internal")}
       ), states AS MATERIALIZED (
         SELECT eligible.id AS internal_product_id,
                review.id AS review_id,
                ${effectiveStatusSql} AS effective_status,
                review.payload_hash,
                review.target_id
         FROM eligible
         CROSS JOIN target_export_revisions revision
         LEFT JOIN target_product_preflight_reviews review
           ON review.target_id = revision.target_id
          AND review.internal_product_id = eligible.id
         JOIN internal_products internal ON internal.id = eligible.id
         WHERE revision.target_id = $1
       )
       SELECT COUNT(*)::BIGINT AS candidate_count,
              COUNT(review_id)::BIGINT AS reviewed_count,
              COUNT(*) FILTER (WHERE review_id IS NULL)::BIGINT AS unreviewed_count,
              COUNT(*) FILTER (WHERE effective_status = 'checking')::BIGINT AS checking_count,
              COUNT(*) FILTER (WHERE effective_status = 'ready')::BIGINT AS ready_count,
              COUNT(*) FILTER (
                WHERE effective_status = 'ready'
                  AND payload_hash IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM jobs active_job
                    WHERE active_job.job_type = 'export_product'
                      AND active_job.status IN ('pending', 'running', 'retry')
                      AND active_job.payload->>'targetId' = states.target_id::TEXT
                      AND active_job.payload->>'internalProductId' = states.internal_product_id::TEXT
                  )
              )::BIGINT AS exportable_count,
              COUNT(*) FILTER (WHERE effective_status = 'blocked')::BIGINT AS blocked_count,
              COUNT(*) FILTER (WHERE effective_status = 'stale')::BIGINT AS stale_count,
              COUNT(*) FILTER (WHERE effective_status = 'error')::BIGINT AS error_count
       FROM states`,
      [query.targetId],
    );
    const hasMore = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    const summaryRow = summaryResult.rows[0] ?? {};
    const summary: ExportControlReadinessSummary = {
      candidateCount: Number(summaryRow.candidate_count ?? 0),
      reviewedCount: Number(summaryRow.reviewed_count ?? 0),
      unreviewedCount: Number(summaryRow.unreviewed_count ?? 0),
      checkingCount: Number(summaryRow.checking_count ?? 0),
      readyCount: Number(summaryRow.ready_count ?? 0),
      exportableCount: Number(summaryRow.exportable_count ?? 0),
      blockedCount: Number(summaryRow.blocked_count ?? 0),
      staleCount: Number(summaryRow.stale_count ?? 0),
      errorCount: Number(summaryRow.error_count ?? 0),
    };
    return {
      items: rows.map(mapListItem),
      nextCursor: hasMore && last !== undefined
        ? { checkedAt: timestamp(last, "checked_at"), id: text(last, "id") }
        : null,
      summary,
    };
  }

  async preparePreflightCandidates(input: {
    readonly targetId: EntityId;
    readonly sourceProductIds?: readonly EntityId[];
    readonly mode?: "all" | "stale";
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
                  revision.revision AS configuration_revision,
                  NOT $3::BOOLEAN
                    AND review.id IS NOT NULL
                    AND review.status = 'ready'
                    AND review.internal_content_hash = internal.content_hash
                    AND review.remote_revision = revision.remote_revision
                    AND review.configuration_revision <> revision.revision
                    AS use_cached_wordpress
           FROM internal_products internal
           JOIN source_products source_product ON source_product.id = internal.source_product_id
           JOIN sources source ON source.id = source_product.source_id
           JOIN target_export_revisions revision ON revision.target_id = $1
           LEFT JOIN target_product_preflight_reviews review
             ON review.target_id = $1 AND review.internal_product_id = internal.id
           WHERE ${exportEligibleInternalSql("internal")}
             AND ($2::BIGINT[] IS NULL OR internal.source_product_id = ANY($2::BIGINT[]))
             AND NOT EXISTS (
               SELECT 1 FROM jobs job
               WHERE job.job_type = 'preflight_product'
                 AND job.status IN ('pending', 'running', 'retry')
                 AND job.payload->>'targetId' = $1::TEXT
                 AND job.payload->>'sourceProductId' = internal.source_product_id::TEXT
             )
             AND CASE WHEN $3::BOOLEAN THEN COALESCE(review.status, '') <> 'checking'
               WHEN $4::BOOLEAN THEN review.id IS NOT NULL
                 AND review.status <> 'checking'
                 AND (review.status = 'stale'
                   OR review.configuration_revision <> revision.revision
                   OR review.internal_content_hash <> internal.content_hash)
               ELSE review.id IS NULL OR review.status IN ('stale', 'error')
                 OR review.configuration_revision <> revision.revision
                 OR review.internal_content_hash <> internal.content_hash
             END
           ORDER BY CASE WHEN $2::BIGINT[] IS NULL THEN 0 ELSE ARRAY_POSITION($2::BIGINT[], internal.source_product_id) END,
                    CASE WHEN review.id IS NULL THEN 1 ELSE 0 END,
                    internal.updated_at DESC, internal.id DESC
           LIMIT $5
           FOR UPDATE OF internal SKIP LOCKED
         ), marked AS (
           INSERT INTO target_product_preflight_reviews (
             target_id, internal_product_id, source_product_id, source_code,
             source_external_id, title, image_url, search_text, status, phase,
             internal_content_hash, configuration_revision, used_cached_wordpress,
             checked_at, updated_at
           )
           SELECT $1, selected.internal_product_id, selected.source_product_id,
                  selected.source_code, selected.source_external_id, selected.title,
                  selected.image_url,
                  CONCAT_WS(' ', selected.source_product_id::TEXT, selected.source_external_id, selected.title),
                  'checking',
                  'preflight', selected.content_hash,
                  selected.configuration_revision, selected.use_cached_wordpress, NOW(), NOW()
           FROM selected
           ON CONFLICT (target_id, internal_product_id) DO UPDATE
           SET source_external_id = EXCLUDED.source_external_id,
               title = EXCLUDED.title,
               image_url = EXCLUDED.image_url,
               search_text = EXCLUDED.search_text,
               status = 'checking', phase = 'preflight', error = NULL,
               internal_content_hash = EXCLUDED.internal_content_hash,
               configuration_revision = EXCLUDED.configuration_revision,
               used_cached_wordpress = EXCLUDED.used_cached_wordpress,
               preflight_cache = CASE WHEN EXCLUDED.used_cached_wordpress
                 THEN target_product_preflight_reviews.preflight_cache
                   || JSONB_BUILD_OBJECT('_previousStatus', target_product_preflight_reviews.status)
                 ELSE target_product_preflight_reviews.preflight_cache END,
               checked_at = NOW(), updated_at = NOW()
           RETURNING source_product_id, internal_product_id
         )
         SELECT marked.*, NOT selected.use_cached_wordpress AS refresh_wordpress
         FROM marked
         JOIN selected USING (source_product_id, internal_product_id)`,
        [input.targetId, input.sourceProductIds ?? null, explicit, input.mode === "stale", input.limit],
      );
      return result.rows.map((row) => ({
        sourceProductId: text(row, "source_product_id"),
        internalProductId: text(row, "internal_product_id"),
        refreshWordPress: row.refresh_wordpress === true,
      }));
    });
  }

  async getCachedPreflight(targetId: EntityId, internalProductId: EntityId): Promise<CachedExportControlPreflight | null> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT status, external_id, will_create, matched_by, wordpress_checked_at,
              wordpress_state_hash, preflight_cache, risk_level, change_flags,
              variation_change_count, deactivated_variation_count, change_summary, blockers,
              used_cached_wordpress
       FROM target_product_preflight_reviews
       WHERE target_id = $1 AND internal_product_id = $2`,
      [targetId, internalProductId],
    );
    const row = result.rows[0];
    if (row === undefined || row.status === "stale") return null;
    const cache = row.preflight_cache as JsonObject;
    const cachedStatus = row.status === "checking" && row.used_cached_wordpress === true
      ? cache._previousStatus
      : row.status;
    if (cachedStatus !== "ready" && cachedStatus !== "blocked" && cachedStatus !== "error") return null;
    return {
      status: String(cachedStatus) as CachedExportControlPreflight["status"],
      externalId: nullableText(row, "external_id"),
      willCreate: row.will_create === null || row.will_create === undefined ? null : row.will_create === true,
      matchedBy: nullableText(row, "matched_by"),
      wordpressCheckedAt: nullableTimestamp(row, "wordpress_checked_at"),
      wordpressStateHash: nullableText(row, "wordpress_state_hash"),
      preflightCache: cache,
      riskLevel: text(row, "risk_level") as CachedExportControlPreflight["riskLevel"],
      changeFlags: flags(row.change_flags),
      variationChangeCount: Number(row.variation_change_count),
      deactivatedVariationCount: Number(row.deactivated_variation_count),
      changeSummary: row.change_summary as JsonObject,
      blockers: row.blockers as CachedExportControlPreflight["blockers"],
    };
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
         internal_content_hash, configuration_revision, remote_revision, payload_hash, external_id,
         will_create, matched_by, risk_level, change_flags, field_change_count,
         taxonomy_added_count, taxonomy_removed_count, image_change_count,
         variation_change_count, deactivated_variation_count, blockers,
         change_summary, wordpress_checked_at, wordpress_state_hash,
         used_cached_wordpress, preflight_cache, error, checked_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         CONCAT_WS(' ', $3::BIGINT::TEXT, $5::TEXT, $6::TEXT), $8, $9,
         $10, $11::BIGINT, (SELECT remote_revision FROM target_export_revisions WHERE target_id = $1),
         $12, $13, $14, $15, $16, $17::TEXT[], $18, $19,
         $20, $21, $22, $23, $24::JSONB, $25::JSONB, $26, $27,
         $28, $29::JSONB, $30, NOW(), NOW()
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
         remote_revision = EXCLUDED.remote_revision,
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
         wordpress_checked_at = EXCLUDED.wordpress_checked_at,
         wordpress_state_hash = EXCLUDED.wordpress_state_hash,
         used_cached_wordpress = EXCLUDED.used_cached_wordpress,
         preflight_cache = EXCLUDED.preflight_cache,
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
        JSON.stringify(input.changeSummary), input.wordpressCheckedAt, input.wordpressStateHash,
        input.usedCachedWordPress, JSON.stringify(input.preflightCache), input.error ?? null,
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

  async listExportCandidates(input: ExportCandidateQuery): Promise<readonly ExportControlExportCandidate[]> {
    if (input.filter?.status !== undefined && input.filter.status !== "ready") return [];
    if (input.campaignId !== undefined) {
      return this.listCampaignExportCandidates({ ...input, campaignId: input.campaignId });
    }
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
    if (input.excludeNoChanges === true) where.push("NOT review.change_flags @> ARRAY['no_changes']::TEXT[]");
    if (input.campaignId !== undefined) {
      const campaignId = add(input.campaignId);
      where.push(`NOT EXISTS (
        SELECT 1
        FROM target_export_batch_items previous_item
        JOIN target_export_batches previous_batch ON previous_batch.id = previous_item.batch_id
        WHERE previous_batch.campaign_id = ${campaignId}::BIGINT
          AND previous_item.internal_product_id = review.internal_product_id
      )`);
      where.push(`EXISTS (
        SELECT 1
        FROM target_export_campaigns campaign
        WHERE campaign.id = ${campaignId}::BIGINT
          AND (campaign.catalog_run_id IS NULL OR EXISTS (
            SELECT 1
            FROM wordpress_catalog_run_items catalog_item
            WHERE catalog_item.run_id = campaign.catalog_run_id
              AND catalog_item.internal_product_id = review.internal_product_id
              AND catalog_item.match_status = 'matched'
          ))
      )`);
    }
    where.push(...filterSql(input.filter ?? {}, add, { includeStatus: false }));
    const limit = add(input.limit);
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT review.id, review.source_product_id, review.internal_product_id,
              review.payload_hash, review.will_create, review.external_id,
              review.matched_by, review.risk_level, review.change_flags,
              review.wordpress_state_hash
       FROM target_product_preflight_reviews review
       JOIN target_export_revisions revision ON revision.target_id = review.target_id
       JOIN internal_products internal
         ON internal.id = review.internal_product_id
        AND internal.content_hash = review.internal_content_hash
        AND ${exportEligibleInternalSql("internal")}
       WHERE ${where.join(" AND ")}
       ORDER BY review.checked_at DESC, review.id DESC
       LIMIT ${limit}`,
      parameters,
    );
    return result.rows.map(mapExportCandidate);
  }

  private async listCampaignExportCandidates(
    input: ExportCandidateQuery & { readonly campaignId: EntityId },
  ): Promise<readonly ExportControlExportCandidate[]> {
    const selected: ExportControlExportCandidate[] = [];
    let beforeCheckedAt: unknown | null = null;
    let beforeId: EntityId | null = null;

    while (selected.length < input.limit) {
      const pageParameters: unknown[] = [];
      const addPage = (value: unknown): string => { pageParameters.push(value); return `$${pageParameters.length}`; };
      const pageWhere = [
        `review.target_id = ${addPage(input.targetId)}`,
        "review.status = 'ready'",
        "review.configuration_revision = revision.revision",
        "review.payload_hash IS NOT NULL",
      ];
      if (input.sourceProductIds !== undefined) {
        pageWhere.push(`review.source_product_id = ANY(${addPage(input.sourceProductIds)}::BIGINT[])`);
      }
      if (input.excludeNoChanges === true) {
        pageWhere.push("NOT review.change_flags @> ARRAY['no_changes']::TEXT[]");
      }
      const pageCampaignId = addPage(input.campaignId);
      pageWhere.push(`EXISTS (
        SELECT 1 FROM target_export_source_refreshes source_refresh
        WHERE source_refresh.campaign_id = ${pageCampaignId}::BIGINT
          AND source_refresh.internal_product_id = review.internal_product_id
          AND source_refresh.internal_content_hash = review.internal_content_hash
          AND source_refresh.status = 'ready'
      )`);
      pageWhere.push(...filterSql(input.filter ?? {}, addPage, { includeStatus: false }));
      if (beforeCheckedAt !== null && beforeId !== null) {
        pageWhere.push(`(review.checked_at, review.id) < (${addPage(beforeCheckedAt)}::TIMESTAMPTZ, ${addPage(beforeId)}::BIGINT)`);
      }
      const pageLimit = addPage(campaignCandidatePageSize);
      const page = await queryPool<DatabaseRow>(this.pool,
        `SELECT review.id, review.checked_at
         FROM target_product_preflight_reviews review
         JOIN target_export_revisions revision ON revision.target_id = review.target_id
         WHERE ${pageWhere.join(" AND ")}
         ORDER BY review.checked_at DESC, review.id DESC
         LIMIT ${pageLimit}`,
        pageParameters,
      );
      if (page.rows.length === 0) break;

      const last = page.rows.at(-1)!;
      beforeCheckedAt = last.checked_at;
      beforeId = text(last, "id");

      const eligibilityParameters: unknown[] = [];
      const addEligibility = (value: unknown): string => {
        eligibilityParameters.push(value);
        return `$${eligibilityParameters.length}`;
      };
      const eligibilityWhere = [
        `review.id = ANY(${addEligibility(page.rows.map((row) => text(row, "id")))}::BIGINT[])`,
        `review.target_id = ${addEligibility(input.targetId)}`,
        "review.status = 'ready'",
        "review.configuration_revision = revision.revision",
        "review.payload_hash IS NOT NULL",
        "NOT EXISTS (SELECT 1 FROM jobs active_job WHERE active_job.job_type = 'export_product' AND active_job.status IN ('pending', 'running', 'retry') AND active_job.payload->>'targetId' = review.target_id::TEXT AND active_job.payload->>'internalProductId' = review.internal_product_id::TEXT)",
      ];
      if (input.sourceProductIds !== undefined) {
        eligibilityWhere.push(`review.source_product_id = ANY(${addEligibility(input.sourceProductIds)}::BIGINT[])`);
      }
      if (input.excludeNoChanges === true) {
        eligibilityWhere.push("NOT review.change_flags @> ARRAY['no_changes']::TEXT[]");
      }
      eligibilityWhere.push(...filterSql(input.filter ?? {}, addEligibility, { includeStatus: false }));
      const campaignId = addEligibility(input.campaignId);
      eligibilityWhere.push(`NOT EXISTS (
        SELECT 1
        FROM target_export_batch_items previous_item
        JOIN target_export_batches previous_batch ON previous_batch.id = previous_item.batch_id
        WHERE previous_batch.campaign_id = ${campaignId}::BIGINT
          AND previous_item.internal_product_id = review.internal_product_id
      )`);
      eligibilityWhere.push(`EXISTS (
        SELECT 1
        FROM target_export_campaigns campaign
        WHERE campaign.id = ${campaignId}::BIGINT
          AND (campaign.catalog_run_id IS NULL OR EXISTS (
            SELECT 1
            FROM wordpress_catalog_run_items catalog_item
            WHERE catalog_item.run_id = campaign.catalog_run_id
              AND catalog_item.internal_product_id = review.internal_product_id
              AND catalog_item.match_status = 'matched'
          ))
      )`);
      const remainingLimit = addEligibility(input.limit - selected.length);
      const eligible = await queryPool<DatabaseRow>(this.pool,
        `SELECT review.id, review.source_product_id, review.internal_product_id,
                 review.payload_hash, review.will_create, review.external_id,
                 review.matched_by, review.risk_level, review.change_flags,
                 review.wordpress_state_hash, source_refresh.id AS source_refresh_id
         FROM target_product_preflight_reviews review
         JOIN target_export_revisions revision ON revision.target_id = review.target_id
         JOIN target_export_source_refreshes source_refresh
           ON source_refresh.campaign_id = ${campaignId}::BIGINT
          AND source_refresh.internal_product_id = review.internal_product_id
          AND source_refresh.internal_content_hash = review.internal_content_hash
          AND source_refresh.status = 'ready'
         JOIN LATERAL (
           SELECT internal.id
           FROM internal_products internal
           WHERE internal.id = review.internal_product_id
             AND internal.content_hash = review.internal_content_hash
             AND ${exportEligibleInternalSql("internal")}
           LIMIT 1
         ) eligible_internal ON TRUE
         WHERE ${eligibilityWhere.join(" AND ")}
         ORDER BY review.checked_at DESC, review.id DESC
         LIMIT ${remainingLimit}`,
        eligibilityParameters,
      );
      selected.push(...eligible.rows.map(mapExportCandidate));
    }

    return selected;
  }

  async createBatch(input: {
    readonly targetId: EntityId;
    readonly filter: JsonObject;
    readonly actor: string;
    readonly reason?: string;
    readonly candidates: readonly ExportControlExportCandidate[];
    readonly campaignId?: EntityId;
  }): Promise<{
    readonly batchId: EntityId;
    readonly items: readonly ExportControlBatchItemRecord[];
    readonly jobIds: readonly EntityId[];
  }> {
    if (input.candidates.length === 0) throw new IntegrationContractError("Нет готовых товаров для экспорта");
    return transaction(this.pool, async (client) => {
      const batch = await client.query<DatabaseRow>(
        `INSERT INTO target_export_batches (target_id, filter, actor, reason, campaign_id)
         VALUES ($1, $2::JSONB, $3, $4, $5) RETURNING id`,
        [input.targetId, JSON.stringify(input.filter), input.actor, input.reason ?? null, input.campaignId ?? null],
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
           approved_external_id, approved_matched_by, approved_wordpress_state_hash
         )
         SELECT $1, $2, review.id, review.source_product_id,
                review.internal_product_id, review.payload_hash, review.will_create,
                review.external_id, review.matched_by, review.wordpress_state_hash
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
      if (input.campaignId !== undefined) {
        const refreshIds = input.candidates.map((candidate) => candidate.sourceRefreshId).filter((id): id is string => id !== undefined);
        if (refreshIds.length !== input.candidates.length) {
          throw new IntegrationContractError("Для части товаров не готов свежий снимок source");
        }
        const readyRefreshes = await client.query<DatabaseRow>(
          `SELECT COUNT(*)::INT AS count
           FROM target_export_source_refreshes
           WHERE id = ANY($1::BIGINT[]) AND campaign_id = $2 AND status = 'ready'`,
          [refreshIds, input.campaignId],
        );
        if (Number(readyRefreshes.rows[0]?.count ?? 0) !== input.candidates.length) {
          throw new IntegrationContractError("Свежий снимок source изменился до постановки экспорта");
        }
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
            ...(candidate.sourceRefreshId === undefined ? {} : { sourceRefreshId: candidate.sourceRefreshId }),
            approval: {
              preflightReviewId: candidate.reviewId,
              payloadHash: candidate.payloadHash,
              willCreate: candidate.willCreate,
              externalId: candidate.externalId,
              matchedBy: candidate.matchedBy,
              ...(candidate.wordpressStateHash === null ? {} : { wordpressStateHash: candidate.wordpressStateHash }),
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
                selected.reason, selected.created_at, selected.campaign_id
       ORDER BY selected.created_at DESC, selected.id DESC`,
      [targetId, limit],
    );
    return result.rows.map((row) => ({
      id: text(row, "id"), targetId: text(row, "target_id"), actor: text(row, "actor"),
      reason: nullableText(row, "reason"), createdAt: timestamp(row, "created_at"),
      campaignId: nullableText(row, "campaign_id"),
      itemCount: Number(row.item_count), pendingCount: Number(row.pending_count),
      runningCount: Number(row.running_count), completedCount: Number(row.completed_count),
      failedCount: Number(row.failed_count),
    }));
  }

  async createCampaign(input: {
    readonly targetId: EntityId;
    readonly actor: string;
    readonly reason?: string;
    readonly mode: ExportCampaignMode;
    readonly catalogRunId?: EntityId;
    readonly preflightWindow: number;
    readonly maxExports?: number;
  }): Promise<ExportCampaignRecord> {
    try {
      const result = await queryPool<DatabaseRow>(this.pool,
        `WITH inserted AS (
           INSERT INTO target_export_campaigns (
             target_id, actor, reason, mode, catalog_run_id, preflight_window, max_exports
           )
           SELECT $1, $2, $3, $4, $5, $6, $7
           WHERE $5::BIGINT IS NULL OR EXISTS (
             SELECT 1
             FROM wordpress_catalog_runs catalog_run
             WHERE catalog_run.id = $5::BIGINT
               AND catalog_run.target_id = $1
               AND catalog_run.status = 'completed'
               AND catalog_run.catalog_complete = TRUE
           )
           RETURNING *
         )
         ${campaignProgressSql.replace("FROM target_export_campaigns campaign", "FROM inserted campaign")}
         GROUP BY campaign.id, campaign.target_id, campaign.status, campaign.actor, campaign.reason,
                  campaign.mode, campaign.catalog_run_id,
                  campaign.preflight_window, campaign.max_exports, campaign.acknowledged_failed_count, campaign.last_error,
                  campaign.created_at, campaign.updated_at, campaign.paused_at, campaign.completed_at,
                  campaign.scan_before_internal_product_id, campaign.scan_complete`,
        [input.targetId, input.actor, input.reason ?? null, input.mode, input.catalogRunId ?? null,
          input.preflightWindow, input.maxExports ?? null],
      );
      if (result.rows[0] === undefined) {
        throw new IntegrationContractError("Для полной выгрузки нужен завершённый полный снимок каталога WordPress");
      }
      return mapCampaign(result.rows[0]!);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new IntegrationContractError("Для этого target уже запущена выгрузка; сначала остановите её", { cause: error });
      }
      throw error;
    }
  }

  async listCampaigns(targetId: EntityId, limit: number): Promise<readonly ExportCampaignRecord[]> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `${campaignProgressSql}
       WHERE campaign.target_id = $1
       GROUP BY campaign.id
       ORDER BY campaign.created_at DESC, campaign.id DESC
       LIMIT $2`,
      [targetId, limit],
    );
    return result.rows.map(mapCampaign);
  }

  async getRunningCampaign(): Promise<ExportCampaignRecord | null> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `${campaignProgressSql}
       WHERE campaign.status = 'running'
       GROUP BY campaign.id
       ORDER BY campaign.created_at, campaign.id
       LIMIT 1`,
    );
    return result.rows[0] === undefined ? null : mapCampaign(result.rows[0]);
  }

  async setCampaignStatus(input: {
    readonly campaignId: EntityId;
    readonly status: "running" | "paused" | "completed";
    readonly error?: string;
  }): Promise<ExportCampaignRecord> {
    return transaction(this.pool, async (client) => {
      if (input.status === "running") {
        const current = await client.query<DatabaseRow>(
          "SELECT target_id FROM target_export_campaigns WHERE id = $1 FOR UPDATE",
          [input.campaignId],
        );
        if (current.rows[0] === undefined) throw new IntegrationContractError("Кампания выгрузки не найдена");
      }
      const updated = await client.query<DatabaseRow>(
        `UPDATE target_export_campaigns
         SET status = $2,
             last_error = CASE WHEN $2 = 'running' THEN NULL ELSE COALESCE($3, last_error) END,
             acknowledged_failed_count = CASE WHEN $2 = 'running' THEN (
               SELECT COUNT(*)::INT
               FROM target_export_batches batch
               JOIN target_export_batch_items item ON item.batch_id = batch.id
               JOIN jobs job ON job.id = item.job_id
               WHERE batch.campaign_id = target_export_campaigns.id AND job.status = 'failed'
             ) ELSE acknowledged_failed_count END,
             paused_at = CASE WHEN $2 = 'paused' THEN NOW() ELSE paused_at END,
             completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [input.campaignId, input.status, input.error ?? null],
      );
      if (updated.rows[0] === undefined) throw new IntegrationContractError("Кампания выгрузки не найдена");
      const result = await client.query<DatabaseRow>(
        `${campaignProgressSql}
         WHERE campaign.id = $1
         GROUP BY campaign.id`,
        [input.campaignId],
      );
      return mapCampaign(result.rows[0]!);
    });
  }

  async listCampaignItems(campaignId: EntityId, limit: number): Promise<readonly ExportCampaignItemRecord[]> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT item.id, item.batch_id, item.source_product_id, item.internal_product_id,
              review.title, COALESCE(product.external_id, item.approved_external_id) AS wordpress_external_id,
              job.status, job.created_at, job.finished_at, job.last_error
       FROM target_export_batch_items item
       JOIN target_export_batches batch ON batch.id = item.batch_id
       JOIN target_product_preflight_reviews review ON review.id = item.preflight_review_id
       LEFT JOIN target_products product
         ON product.target_id = item.target_id AND product.internal_product_id = item.internal_product_id
       JOIN jobs job ON job.id = item.job_id
       WHERE batch.campaign_id = $1
       ORDER BY item.id DESC
       LIMIT $2`,
      [campaignId, limit],
    );
    return result.rows.map((row) => ({
      id: text(row, "id"),
      batchId: text(row, "batch_id"),
      sourceProductId: text(row, "source_product_id"),
      internalProductId: text(row, "internal_product_id"),
      title: text(row, "title"),
      wordpressExternalId: nullableText(row, "wordpress_external_id"),
      status: text(row, "status") as ExportCampaignItemRecord["status"],
      createdAt: timestamp(row, "created_at"),
      finishedAt: nullableTimestamp(row, "finished_at"),
      error: nullableText(row, "last_error"),
    }));
  }

  async countActivePreflights(targetId: EntityId): Promise<number> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT COUNT(*)::INT AS count
       FROM jobs
       WHERE job_type = 'preflight_product'
         AND status IN ('pending', 'running', 'retry')
         AND payload->>'targetId' = $1::TEXT`,
      [targetId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async prepareCampaignPreflightCandidates(input: {
    readonly campaignId: EntityId;
    readonly limit: number;
  }): Promise<readonly ExportControlPreflightCandidate[]> {
    return transaction(this.pool, async (client) => {
      const campaign = await client.query<DatabaseRow>(
        `SELECT id, target_id, catalog_run_id, scan_before_internal_product_id, scan_complete
         FROM target_export_campaigns
         WHERE id = $1 AND status = 'running'
         FOR UPDATE`,
        [input.campaignId],
      );
      const state = campaign.rows[0];
      if (state === undefined || state.scan_complete === true) return [];
      const targetId = text(state, "target_id");
      const result = await client.query<DatabaseRow>(
        `WITH selected AS MATERIALIZED (
           SELECT internal.id AS internal_product_id, internal.source_product_id,
                  internal.content_hash, source.code AS source_code,
                  source_product.external_id AS source_external_id,
                  COALESCE(NULLIF(internal.data->>'title', ''), source_product.source_key) AS title,
                  NULLIF(internal.data->'images'->0->>'url', '') AS image_url,
                  revision.revision AS configuration_revision,
                  review.id IS NOT NULL
                    AND review.status = 'ready'
                    AND review.internal_content_hash = internal.content_hash
                    AND review.remote_revision = revision.remote_revision
                    AND review.configuration_revision <> revision.revision AS use_cached_wordpress
           FROM internal_products internal
           JOIN source_products source_product ON source_product.id = internal.source_product_id
           JOIN sources source ON source.id = source_product.source_id
           JOIN target_export_revisions revision ON revision.target_id = $1
           LEFT JOIN target_product_preflight_reviews review
             ON review.target_id = $1 AND review.internal_product_id = internal.id
           WHERE ${exportEligibleInternalSql("internal")}
             AND ($2::BIGINT IS NULL OR internal.id < $2::BIGINT)
             AND ($4::BIGINT IS NULL OR EXISTS (
               SELECT 1
               FROM wordpress_catalog_run_items catalog_item
               WHERE catalog_item.run_id = $4::BIGINT
                 AND catalog_item.internal_product_id = internal.id
                 AND catalog_item.match_status = 'matched'
             ))
             AND (review.id IS NULL OR review.status IN ('stale', 'error')
               OR review.configuration_revision <> revision.revision
               OR review.internal_content_hash <> internal.content_hash)
             AND NOT EXISTS (
               SELECT 1 FROM jobs job
               WHERE job.job_type = 'preflight_product'
                 AND job.status IN ('pending', 'running', 'retry')
                 AND job.payload->>'targetId' = $1::TEXT
                 AND job.payload->>'sourceProductId' = internal.source_product_id::TEXT
             )
           ORDER BY internal.id DESC
           LIMIT $3
           FOR UPDATE OF internal SKIP LOCKED
         ), marked AS (
           INSERT INTO target_product_preflight_reviews (
             target_id, internal_product_id, source_product_id, source_code,
             source_external_id, title, image_url, search_text, status, phase,
             internal_content_hash, configuration_revision, used_cached_wordpress,
             checked_at, updated_at
           )
           SELECT $1, selected.internal_product_id, selected.source_product_id,
                  selected.source_code, selected.source_external_id, selected.title,
                  selected.image_url,
                  CONCAT_WS(' ', selected.source_product_id::TEXT, selected.source_external_id, selected.title),
                  'checking', 'preflight', selected.content_hash,
                  selected.configuration_revision, selected.use_cached_wordpress, NOW(), NOW()
           FROM selected
           ON CONFLICT (target_id, internal_product_id) DO UPDATE
           SET source_external_id = EXCLUDED.source_external_id,
               title = EXCLUDED.title,
               image_url = EXCLUDED.image_url,
               search_text = EXCLUDED.search_text,
               status = 'checking', phase = 'preflight', error = NULL,
               internal_content_hash = EXCLUDED.internal_content_hash,
               configuration_revision = EXCLUDED.configuration_revision,
               used_cached_wordpress = EXCLUDED.used_cached_wordpress,
               preflight_cache = CASE WHEN EXCLUDED.used_cached_wordpress
                 THEN target_product_preflight_reviews.preflight_cache
                   || JSONB_BUILD_OBJECT('_previousStatus', target_product_preflight_reviews.status)
                 ELSE target_product_preflight_reviews.preflight_cache END,
               checked_at = NOW(), updated_at = NOW()
           RETURNING source_product_id, internal_product_id
         )
         SELECT marked.*, NOT selected.use_cached_wordpress AS refresh_wordpress
         FROM marked JOIN selected USING (source_product_id, internal_product_id)
         ORDER BY marked.internal_product_id DESC`,
        [targetId, nullableText(state, "scan_before_internal_product_id"), input.limit,
          nullableText(state, "catalog_run_id")],
      );
      const last = result.rows.at(-1);
      await client.query(
        `UPDATE target_export_campaigns
         SET scan_before_internal_product_id = COALESCE($2, scan_before_internal_product_id),
             scan_complete = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [input.campaignId, last === undefined ? null : text(last, "internal_product_id"), last === undefined],
      );
      return result.rows.map((row) => ({
        sourceProductId: text(row, "source_product_id"),
        internalProductId: text(row, "internal_product_id"),
        refreshWordPress: row.refresh_wordpress === true,
      }));
    });
  }

  async prepareCampaignSourceRefreshCandidates(input: {
    readonly campaignId: EntityId;
    readonly limit: number;
  }): Promise<readonly ExportSourceRefreshCandidate[]> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `WITH campaign AS MATERIALIZED (
         SELECT id, target_id, catalog_run_id, mode
         FROM target_export_campaigns campaign
         WHERE campaign.id = $1 AND campaign.status = 'running'
       ), eligible_reviews AS MATERIALIZED (
         SELECT review.id, review.internal_product_id, review.source_product_id,
                review.internal_content_hash, review.checked_at
         FROM campaign
         JOIN target_product_preflight_reviews review ON review.target_id = campaign.target_id
         JOIN target_export_revisions revision
           ON revision.target_id = review.target_id
          AND revision.revision = review.configuration_revision
         WHERE review.status = 'ready'
           AND review.payload_hash IS NOT NULL
           AND review.will_create = FALSE
           AND NOT review.change_flags @> ARRAY['no_changes']::TEXT[]
           AND (campaign.mode <> 'safe' OR review.risk_level = 'none')
           AND NOT EXISTS (
             SELECT 1 FROM target_export_batch_items item
             JOIN target_export_batches batch ON batch.id = item.batch_id
             WHERE batch.campaign_id = $1
               AND item.internal_product_id = review.internal_product_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM target_export_source_refreshes existing
             WHERE existing.campaign_id = $1
               AND existing.internal_product_id = review.internal_product_id
           )
       ), selected AS MATERIALIZED (
         SELECT campaign.id AS campaign_id, campaign.target_id,
                review.internal_product_id, review.source_product_id,
                review.internal_content_hash
         FROM campaign
         JOIN eligible_reviews review ON TRUE
         JOIN internal_products internal
           ON internal.id = review.internal_product_id
          AND internal.content_hash = review.internal_content_hash
          AND ${exportEligibleInternalSql("internal")}
         WHERE campaign.catalog_run_id IS NULL OR EXISTS (
           SELECT 1 FROM wordpress_catalog_run_items catalog_item
           WHERE catalog_item.run_id = campaign.catalog_run_id
             AND catalog_item.internal_product_id = review.internal_product_id
             AND catalog_item.match_status = 'matched'
         )
         ORDER BY review.checked_at DESC, review.id DESC
         LIMIT $2
       ), inserted AS (
         INSERT INTO target_export_source_refreshes (
           campaign_id, target_id, internal_product_id, source_product_id,
           internal_content_hash, status
         )
         SELECT campaign_id, target_id, internal_product_id, source_product_id,
                internal_content_hash, 'pending'
         FROM selected
         ON CONFLICT (campaign_id, internal_product_id) DO NOTHING
         RETURNING id, campaign_id, internal_product_id, source_product_id
       )
       SELECT * FROM inserted ORDER BY id`,
      [input.campaignId, input.limit],
    );
    return result.rows.map((row) => ({
      id: text(row, "id"),
      campaignId: text(row, "campaign_id"),
      internalProductId: text(row, "internal_product_id"),
      sourceProductId: text(row, "source_product_id"),
    }));
  }

  async countCampaignSourceRefreshBuffer(campaignId: EntityId): Promise<number> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT COUNT(*)::INT AS count
       FROM target_export_source_refreshes refresh
       WHERE refresh.campaign_id = $1
         AND refresh.status IN ('pending', 'ready')
         AND NOT EXISTS (
           SELECT 1 FROM target_export_batch_items item
           JOIN target_export_batches batch ON batch.id = item.batch_id
           WHERE batch.campaign_id = refresh.campaign_id
             AND item.internal_product_id = refresh.internal_product_id
         )`,
      [campaignId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async saveCampaignSourceRefresh(input: {
    readonly refreshId: EntityId;
    readonly variants: ExportSourceRefreshRecord["variants"];
  }): Promise<void> {
    const result = await queryPool(this.pool,
      `UPDATE target_export_source_refreshes
       SET status = 'ready', variants = $2::JSONB, fetched_at = NOW(), error = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [input.refreshId, JSON.stringify(input.variants)],
    );
    if (result.rows.length !== 1) throw new IntegrationContractError("Буфер source refresh не найден или уже завершён");
  }

  async saveCampaignSourceRefreshError(refreshId: EntityId, error: string): Promise<void> {
    await queryPool(this.pool,
      `UPDATE target_export_source_refreshes
       SET status = 'error', error = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [refreshId, error],
    );
  }

  async getCampaignSourceRefresh(refreshId: EntityId): Promise<ExportSourceRefreshRecord | null> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT id, campaign_id, target_id, internal_product_id, source_product_id,
              internal_content_hash, status, variants
       FROM target_export_source_refreshes WHERE id = $1`,
      [refreshId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.variants !== null && row.variants !== undefined && !Array.isArray(row.variants)) {
      throw new IntegrationContractError("Буфер source refresh содержит некорректные варианты");
    }
    return {
      id: text(row, "id"),
      campaignId: text(row, "campaign_id"),
      targetId: text(row, "target_id"),
      internalProductId: text(row, "internal_product_id"),
      sourceProductId: text(row, "source_product_id"),
      internalContentHash: text(row, "internal_content_hash"),
      status: text(row, "status") as ExportSourceRefreshRecord["status"],
      variants: (row.variants ?? null) as ExportSourceRefreshRecord["variants"],
    };
  }
}
