import type { JsonObject } from "../../../contracts/index.js";
import type {
  WordPressCatalogRepository,
  WordPressCatalogRunItemRecord,
  WordPressCatalogRunItemSummaryRecord,
  WordPressCatalogRunRecord,
  WordPressVariationAutoSyncState,
  WordPressVariationAutoTickOutcome,
} from "../../../repositories/index.js";
import type { SqlClient, SqlPool } from "../sql-executor.js";
import type { DatabaseRow } from "./row-mappers.js";

function text(row: DatabaseRow, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) throw new Error(`Database column ${key} is required`);
  return String(value);
}

function nullableText(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function timestamp(row: DatabaseRow, key: string): string {
  const value = row[key];
  return value instanceof Date ? value.toISOString() : text(row, key);
}

function nullableTimestamp(row: DatabaseRow, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : timestamp(row, key);
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
  parameters: readonly unknown[] = [],
): Promise<{ readonly rows: readonly Row[] }> {
  const client = await pool.connect();
  try { return await client.query<Row>(sql, [...parameters]); } finally { client.release(); }
}

function mapRun(row: DatabaseRow): WordPressCatalogRunRecord {
  return {
    id: text(row, "id"),
    targetId: text(row, "target_id"),
    targetName: text(row, "target_name"),
    sourceCode: text(row, "source_code"),
    status: text(row, "status") as WordPressCatalogRunRecord["status"],
    catalogCursor: text(row, "catalog_cursor"),
    catalogComplete: row.catalog_complete === true,
    auditRequested: row.audit_requested === true,
    variationSyncRequested: row.variation_sync_requested === true,
    variationAutoStatus: text(row, "variation_auto_status") as WordPressCatalogRunRecord["variationAutoStatus"],
    variationAutoWindow: Number(row.variation_auto_window),
    variationAutoAcknowledgedFailedCount: Number(row.variation_auto_acknowledged_failed_count),
    variationAutoError: nullableText(row, "variation_auto_error"),
    variationAutoStartedAt: nullableTimestamp(row, "variation_auto_started_at"),
    variationAutoCompletedAt: nullableTimestamp(row, "variation_auto_completed_at"),
    variationSyncIntervalMinutes: Number(row.variation_sync_interval_minutes),
    variationSyncCycle: Number(row.variation_sync_cycle),
    variationSyncLastCycleStartedAt: nullableTimestamp(row, "variation_sync_last_cycle_started_at"),
    variationSyncLastCycleCompletedAt: nullableTimestamp(row, "variation_sync_last_cycle_completed_at"),
    variationSyncNextCycleAt: nullableTimestamp(row, "variation_sync_next_cycle_at"),
    actor: text(row, "actor"),
    reason: nullableText(row, "reason"),
    lastError: nullableText(row, "last_error"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
    completedAt: nullableTimestamp(row, "completed_at"),
    totalCount: Number(row.total_count ?? 0),
    matchedCount: Number(row.matched_count ?? 0),
    unmatchedCount: Number(row.unmatched_count ?? 0),
    ambiguousCount: Number(row.ambiguous_count ?? 0),
    variationPendingCount: Number(row.variation_pending_count ?? 0),
    variationNotStartedCount: Number(row.variation_not_started_count ?? 0),
    variationSubmittedCount: Number(row.variation_submitted_count ?? 0),
    variationCompletedCount: Number(row.variation_completed_count ?? 0),
    variationSkippedCount: Number(row.variation_skipped_count ?? 0),
    variationFailedCount: Number(row.variation_failed_count ?? 0),
    variationEligibleCount: Number(row.variation_eligible_count ?? 0),
    variationCheckedCycleCount: Number(row.variation_checked_cycle_count ?? 0),
    variationDueCount: Number(row.variation_due_count ?? 0),
    variationChangedCount: Number(row.variation_changed_count ?? 0),
    auditPendingCount: Number(row.audit_pending_count ?? 0),
    auditReadyCount: Number(row.audit_ready_count ?? 0),
    auditBlockedCount: Number(row.audit_blocked_count ?? 0),
    auditErrorCount: Number(row.audit_error_count ?? 0),
  };
}

function mapItem(row: DatabaseRow): WordPressCatalogRunItemRecord {
  return {
    id: text(row, "id"),
    runId: text(row, "run_id"),
    wordpressProductId: text(row, "wordpress_product_id"),
    sourceCode: nullableText(row, "source_code"),
    sourceExternalId: nullableText(row, "source_external_id"),
    legacyGoatId: nullableText(row, "legacy_goat_id"),
    sku: nullableText(row, "sku"),
    sourceProductId: nullableText(row, "source_product_id"),
    internalProductId: nullableText(row, "internal_product_id"),
    matchStatus: text(row, "match_status") as WordPressCatalogRunItemRecord["matchStatus"],
    matchMethod: nullableText(row, "match_method"),
    matchDetails: row.match_details as JsonObject,
    auditStatus: text(row, "audit_status"),
    auditResult: row.audit_result === null || row.audit_result === undefined ? null : row.audit_result as JsonObject,
    auditError: nullableText(row, "audit_error"),
    variationStatus: text(row, "variation_status"),
    variationPayload: row.variation_payload === null || row.variation_payload === undefined ? null : row.variation_payload as JsonObject,
    variationNotices: Array.isArray(row.variation_notices) ? row.variation_notices as JsonObject[] : [],
    wordpressJobId: nullableText(row, "wordpress_job_id"),
    variationResult: row.variation_result === null || row.variation_result === undefined ? null : row.variation_result as JsonObject,
    variationError: nullableText(row, "variation_error"),
    variationSourceHash: nullableText(row, "variation_source_hash"),
    variationAppliedSourceHash: nullableText(row, "variation_applied_source_hash"),
    variationSourceVariants: Array.isArray(row.variation_source_variants)
      ? row.variation_source_variants as unknown as WordPressCatalogRunItemRecord["variationSourceVariants"]
      : [],
    variationSyncCycle: Number(row.variation_sync_cycle ?? 0),
    payload: row.payload as JsonObject,
    targetTermLabels: row.target_term_labels === null || row.target_term_labels === undefined ? {} : row.target_term_labels as JsonObject,
    proposedImages: Array.isArray(row.proposed_images) ? row.proposed_images as JsonObject[] : [],
    fetchedAt: timestamp(row, "fetched_at"),
    variationCheckedAt: nullableTimestamp(row, "variation_checked_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function mapItemSummary(row: DatabaseRow): WordPressCatalogRunItemSummaryRecord {
  return {
    id: text(row, "id"),
    wordpressProductId: text(row, "wordpress_product_id"),
    sourceExternalId: nullableText(row, "source_external_id"),
    legacyGoatId: nullableText(row, "legacy_goat_id"),
    sku: nullableText(row, "sku"),
    sourceProductId: nullableText(row, "source_product_id"),
    internalProductId: nullableText(row, "internal_product_id"),
    matchStatus: text(row, "match_status") as WordPressCatalogRunItemSummaryRecord["matchStatus"],
    matchMethod: nullableText(row, "match_method"),
    title: text(row, "title"),
    imageUrl: nullableText(row, "image_url"),
    wordpressVariationCount: Number(row.wordpress_variation_count),
    wordpressImageCount: Number(row.wordpress_image_count),
    auditStatus: text(row, "audit_status"),
    auditRisk: nullableText(row, "audit_risk"),
    auditError: nullableText(row, "audit_error"),
    changeFlags: Array.isArray(row.change_flags) ? row.change_flags.map(String) : [],
    variationStatus: text(row, "variation_status"),
    wordpressJobId: nullableText(row, "wordpress_job_id"),
    variationError: nullableText(row, "variation_error"),
    variationChangedCount: Number(row.variation_changed_count ?? 0),
    snapshotFetchedAt: timestamp(row, "fetched_at"),
    variationCheckedAt: nullableTimestamp(row, "variation_checked_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

const runSelect = `
  SELECT run.*, target.name AS target_name,
         COUNT(item.id)::BIGINT AS total_count,
         COUNT(item.id) FILTER (WHERE item.match_status = 'matched')::BIGINT AS matched_count,
         COUNT(item.id) FILTER (WHERE item.match_status = 'unmatched')::BIGINT AS unmatched_count,
         COUNT(item.id) FILTER (WHERE item.match_status = 'ambiguous')::BIGINT AS ambiguous_count
         ,COUNT(item.id) FILTER (WHERE item.variation_status IN ('pending', 'refreshing', 'ready'))::BIGINT AS variation_pending_count
         ,COUNT(item.id) FILTER (WHERE item.match_status = 'matched' AND item.internal_product_id IS NOT NULL
           AND item.variation_status = 'skipped' AND item.variation_checked_at IS NULL)::BIGINT AS variation_not_started_count
         ,COUNT(item.id) FILTER (WHERE item.variation_status = 'submitted')::BIGINT AS variation_submitted_count
         ,COUNT(item.id) FILTER (WHERE item.variation_status = 'completed')::BIGINT AS variation_completed_count
         ,COUNT(item.id) FILTER (WHERE item.variation_status = 'skipped' AND item.variation_checked_at IS NOT NULL)::BIGINT AS variation_skipped_count
         ,COUNT(item.id) FILTER (WHERE item.variation_status = 'failed')::BIGINT AS variation_failed_count
         ,COUNT(item.id) FILTER (WHERE item.match_status = 'matched' AND item.internal_product_id IS NOT NULL)::BIGINT AS variation_eligible_count
         ,COUNT(item.id) FILTER (WHERE item.match_status = 'matched' AND item.internal_product_id IS NOT NULL
           AND item.variation_sync_cycle = run.variation_sync_cycle AND item.variation_checked_at IS NOT NULL
           AND item.variation_status IN ('completed', 'skipped'))::BIGINT AS variation_checked_cycle_count
         ,COUNT(item.id) FILTER (WHERE item.match_status = 'matched' AND item.internal_product_id IS NOT NULL
           AND item.variation_next_check_at <= NOW() AND item.variation_status NOT IN ('pending', 'refreshing', 'ready', 'submitted'))::BIGINT AS variation_due_count
         ,COUNT(item.id) FILTER (WHERE item.variation_status = 'completed' AND
           COALESCE((item.variation_result->'result'->>'updated_count')::INTEGER, 0) > 0)::BIGINT AS variation_changed_count
         ,COUNT(item.id) FILTER (WHERE item.audit_status IN ('pending', 'running'))::BIGINT AS audit_pending_count
         ,COUNT(item.id) FILTER (WHERE item.audit_status = 'ready')::BIGINT AS audit_ready_count
         ,COUNT(item.id) FILTER (WHERE item.audit_status = 'blocked')::BIGINT AS audit_blocked_count
         ,COUNT(item.id) FILTER (WHERE item.audit_status = 'error')::BIGINT AS audit_error_count
  FROM wordpress_catalog_runs run
  JOIN targets target ON target.id = run.target_id
  LEFT JOIN wordpress_catalog_run_items item ON item.run_id = run.id`;

export class PostgresWordPressCatalogRepository implements WordPressCatalogRepository {
  constructor(private readonly pool: SqlPool) {}

  async createRun(input: Parameters<WordPressCatalogRepository["createRun"]>[0]): Promise<WordPressCatalogRunRecord> {
    const runId = await transaction(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `INSERT INTO wordpress_catalog_runs
           (target_id, source_code, audit_requested, variation_sync_requested, actor, reason)
         VALUES ($1, LOWER($2), $3, $4, $5, $6)
         RETURNING id`,
        [input.targetId, input.sourceCode.trim(), input.auditRequested, input.variationSyncRequested, input.actor, input.reason ?? null],
      );
      const id = text(result.rows[0]!, "id");
      await client.query(
        `INSERT INTO jobs (job_type, payload, status, unique_key)
         VALUES ('sync_wordpress_catalog', JSONB_BUILD_OBJECT('runId', $1::TEXT, 'cursor', '0'), 'pending', $2)`,
        [id, `wordpress-catalog:${id}:0`],
      );
      return id;
    });
    return (await this.getRun(runId))!;
  }

  async getRun(runId: string): Promise<WordPressCatalogRunRecord | null> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `${runSelect} WHERE run.id = $1 GROUP BY run.id, target.name`, [runId]);
    return result.rows[0] === undefined ? null : mapRun(result.rows[0]);
  }

  async listRuns(targetId: string, limit: number): Promise<readonly WordPressCatalogRunRecord[]> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `WITH latest_runs AS MATERIALIZED (
         SELECT id FROM wordpress_catalog_runs
         WHERE target_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
       )
       ${runSelect}
       JOIN latest_runs latest ON latest.id = run.id
       WHERE run.target_id = $1
       GROUP BY run.id, target.name ORDER BY run.created_at DESC, run.id DESC`,
      [targetId, limit],
    );
    return result.rows.map(mapRun);
  }

  async listItems(input: Parameters<WordPressCatalogRepository["listItems"]>[0]): Promise<{ readonly items: readonly WordPressCatalogRunItemSummaryRecord[]; readonly total: number }> {
    const parameters: unknown[] = [input.runId];
    const where = ["item.run_id = $1"];
    if (input.search !== undefined) {
      parameters.push(`%${input.search.trim().toLocaleLowerCase("ru-RU")}%`);
      where.push(`LOWER(model.search_text) LIKE $${parameters.length}`);
    }
    if (input.matchStatus !== undefined) {
      parameters.push(input.matchStatus);
      where.push(`item.match_status = $${parameters.length}`);
    }
    if (input.auditStatus !== undefined) {
      parameters.push(input.auditStatus);
      where.push(`item.audit_status = $${parameters.length}`);
    }
    if (input.risk === "safe") where.push("model.audit_risk = 'none'");
    else if (input.risk !== undefined) {
      parameters.push(input.risk);
      where.push(`model.audit_risk = $${parameters.length}`);
    }
    if (input.operation === "update") where.push("item.match_status = 'matched'");
    else if (input.operation === "unmatched") where.push("item.match_status = 'unmatched'");
    else if (input.operation === "new") where.push("FALSE");
    if (input.changeFlag !== undefined) {
      parameters.push(input.changeFlag);
      where.push(`model.change_flags @> ARRAY[$${parameters.length}]::TEXT[]`);
    }
    if (input.variationFilter === "not_started") {
      where.push("item.variation_status = 'skipped' AND item.variation_checked_at IS NULL");
    } else if (input.variationFilter === "due") {
      where.push("item.match_status = 'matched' AND item.internal_product_id IS NOT NULL AND item.variation_next_check_at <= NOW() AND item.variation_status NOT IN ('pending', 'refreshing', 'ready', 'submitted')");
    } else if (input.variationFilter === "in_progress") {
      where.push("item.variation_status IN ('pending', 'refreshing', 'ready', 'submitted')");
    } else if (input.variationFilter === "skipped") {
      where.push("item.variation_status = 'skipped' AND item.variation_checked_at IS NOT NULL");
    } else if (input.variationFilter === "changed") {
      where.push("item.variation_status = 'completed' AND COALESCE((item.variation_result->'result'->>'updated_count')::INTEGER, 0) > 0");
    } else if (input.variationFilter !== undefined) {
      parameters.push(input.variationFilter);
      where.push(`item.variation_status = $${parameters.length}`);
    }
    const countParameters = [...parameters];
    parameters.push(input.limit, input.offset);
    const [page, count] = await Promise.all([
      queryPool<DatabaseRow>(this.pool,
        `WITH page AS MATERIALIZED (
           SELECT item.id
           FROM wordpress_catalog_run_items item
           JOIN wordpress_catalog_item_read_models model ON model.item_id = item.id
           WHERE ${where.join(" AND ")}
           ORDER BY ${input.variationFilter === "changed" || input.variationFilter === "completed" ? "item.variation_checked_at DESC NULLS LAST, item.id DESC" : "item.id"}
           LIMIT $${parameters.length - 1} OFFSET $${parameters.length}
         )
         SELECT item.id, item.wordpress_product_id, item.source_external_id, item.legacy_goat_id,
                item.sku, item.source_product_id, item.internal_product_id, item.match_status,
                item.match_method, item.audit_status, item.audit_error,
                item.variation_status, item.wordpress_job_id, item.variation_error,
                COALESCE((item.variation_result->'result'->>'updated_count')::INTEGER, 0) AS variation_changed_count,
                item.variation_checked_at, item.updated_at,
                model.title, model.image_url, model.wordpress_variation_count,
                model.wordpress_image_count, model.audit_risk, model.change_flags,
                snapshot.fetched_at
         FROM page
         JOIN wordpress_catalog_run_items item ON item.id = page.id
         JOIN wordpress_catalog_item_read_models model ON model.item_id = item.id
         JOIN wordpress_catalog_snapshots snapshot ON snapshot.id = item.snapshot_id
         ORDER BY ${input.variationFilter === "changed" || input.variationFilter === "completed" ? "item.variation_checked_at DESC NULLS LAST, item.id DESC" : "item.id"}`, parameters),
      queryPool<DatabaseRow>(this.pool,
        `SELECT COUNT(*)::BIGINT AS total
         FROM wordpress_catalog_run_items item
         JOIN wordpress_catalog_item_read_models model ON model.item_id = item.id
         WHERE ${where.join(" AND ")}`, countParameters),
    ]);
    return { items: page.rows.map(mapItemSummary), total: Number(count.rows[0]?.total ?? 0) };
  }

  async getItem(runId: string, itemId: string): Promise<WordPressCatalogRunItemRecord | null> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT item.*, snapshot.payload, snapshot.fetched_at,
              COALESCE(internal.data->'images', '[]'::JSONB) AS proposed_images,
              COALESCE((
                SELECT JSONB_OBJECT_AGG(dictionary.external_id, dictionary.name)
                FROM target_dictionary_values dictionary
                WHERE dictionary.target_id = run.target_id
                   AND dictionary.external_id IN (
                     SELECT DISTINCT term.term_id
                     FROM JSONB_ARRAY_ELEMENTS(COALESCE(item.audit_result->'taxonomies', '[]'::JSONB)) AS taxonomy(row),
                          LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
                            COALESCE(taxonomy.row->'after', '[]'::JSONB)
                            || COALESCE(taxonomy.row->'before', '[]'::JSONB)
                          ) AS term(term_id)
                     UNION
                     SELECT DISTINCT SPLIT_PART(variation.row->>'size', ':', 2)
                     FROM JSONB_ARRAY_ELEMENTS(COALESCE(item.audit_result#>'{variations,items}', '[]'::JSONB)) AS variation(row)
                     WHERE variation.row->>'size' ~ '^pa_[a-z0-9_-]+:[0-9]+$'
                   )
              ), '{}'::JSONB)
              || COALESCE((
                SELECT JSONB_OBJECT_AGG(
                  mapping.row->>'termId',
                  COALESCE(NULLIF(mapping.row->>'displayValue', ''), mapping.row->>'sourceValue')
                )
                FROM JSONB_ARRAY_ELEMENTS(COALESCE(target.config->'sizeMappings', '[]'::JSONB)) AS mapping(row)
                WHERE mapping.row->>'termId' IN (
                  SELECT SPLIT_PART(size.value, ':', 2)
                  FROM JSONB_ARRAY_ELEMENTS_TEXT(
                    COALESCE(item.audit_result#>'{variations,before}', '[]'::JSONB)
                    || COALESCE(item.audit_result#>'{variations,after}', '[]'::JSONB)
                  ) AS size(value)
                  WHERE size.value ~ '^pa_[a-z0-9_-]+:[0-9]+$'
                )
              ), '{}'::JSONB) AS target_term_labels
       FROM wordpress_catalog_run_items item
       JOIN wordpress_catalog_runs run ON run.id = item.run_id
       JOIN targets target ON target.id = run.target_id
       JOIN wordpress_catalog_snapshots snapshot ON snapshot.id = item.snapshot_id
       LEFT JOIN internal_products internal ON internal.id = item.internal_product_id
       WHERE item.run_id = $1 AND item.id = $2`, [runId, itemId]);
    return result.rows[0] === undefined ? null : mapItem(result.rows[0]);
  }

  async savePage(input: Parameters<WordPressCatalogRepository["savePage"]>[0]): Promise<WordPressCatalogRunRecord> {
    await transaction(this.pool, async (client) => {
      const locked = await client.query<DatabaseRow>(
        `SELECT id, catalog_cursor, status FROM wordpress_catalog_runs WHERE id = $1 FOR UPDATE`, [input.runId]);
      const run = locked.rows[0];
      if (run === undefined) throw new Error(`WordPress catalog run not found: ${input.runId}`);
      if (text(run, "status") !== "running" && !input.inventoryOnly) throw new Error(`WordPress catalog run is not running: ${input.runId}`);
      if (text(run, "catalog_cursor") !== input.expectedCursor) {
        throw new Error(`WordPress catalog cursor changed: expected ${input.expectedCursor}, got ${text(run, "catalog_cursor")}`);
      }

      if (input.items.length > 0) {
        const rows = input.items.map((item) => ({
          wordpress_product_id: item.wordpressProductId,
          identity: item.identity,
          payload: item.snapshot,
          content_hash: item.contentHash,
        }));
        await client.query(
          `WITH input AS MATERIALIZED (
             SELECT wordpress_product_id, identity, payload, content_hash
             FROM JSONB_TO_RECORDSET($2::JSONB) AS value(
               wordpress_product_id BIGINT, identity JSONB, payload JSONB, content_hash TEXT
             )
           ), snapshots AS (
             INSERT INTO wordpress_catalog_snapshots
               (target_id, wordpress_product_id, content_hash, payload, fetched_at)
             SELECT run.target_id, input.wordpress_product_id, input.content_hash, input.payload, $3::TIMESTAMPTZ
             FROM input CROSS JOIN wordpress_catalog_runs run
             WHERE run.id = $1
             ON CONFLICT (target_id, wordpress_product_id, content_hash)
             DO UPDATE SET fetched_at = GREATEST(wordpress_catalog_snapshots.fetched_at, EXCLUDED.fetched_at)
             RETURNING id, target_id, wordpress_product_id, content_hash
           ), normalized AS MATERIALIZED (
             SELECT input.*,
                    NULLIF(BTRIM(input.identity->>'source_code'), '') AS identity_source_code,
                    NULLIF(BTRIM(input.identity->>'source_external_id'), '') AS identity_source_external_id,
                    NULLIF(BTRIM(input.identity->>'legacy_goat_id'), '') AS legacy_goat_id,
                    NULLIF(BTRIM(input.payload->'product'->>'sku'), '') AS sku
             FROM input
           ), candidates AS MATERIALIZED (
             SELECT normalized.wordpress_product_id, source_product.id AS source_product_id, 'canonical_identity'::TEXT AS method
             FROM normalized
             JOIN sources source ON LOWER(source.code) = LOWER(normalized.identity_source_code)
             JOIN source_products source_product
               ON source_product.source_id = source.id
              AND source_product.external_id = normalized.identity_source_external_id
             WHERE normalized.identity_source_code IS NOT NULL AND normalized.identity_source_external_id IS NOT NULL
             UNION ALL
             SELECT normalized.wordpress_product_id, source_product.id, 'legacy_goat_id'::TEXT
             FROM normalized
             JOIN wordpress_catalog_runs run ON run.id = $1
             JOIN sources source ON LOWER(source.code) = LOWER(run.source_code)
             JOIN source_products source_product
               ON source_product.source_id = source.id
              AND source_product.external_id = normalized.legacy_goat_id
             WHERE normalized.legacy_goat_id IS NOT NULL
             UNION ALL
             SELECT normalized.wordpress_product_id, source_product.id, 'unique_sku'::TEXT
             FROM normalized
             JOIN wordpress_catalog_runs run ON run.id = $1
             JOIN sources source ON LOWER(source.code) = LOWER(run.source_code)
             JOIN source_products source_product ON source_product.source_id = source.id
             JOIN internal_products internal ON internal.source_product_id = source_product.id
             WHERE normalized.identity_source_code IS NULL
               ${input.inventoryOnly ? "AND FALSE" : ""}
               AND normalized.identity_source_external_id IS NULL
               AND normalized.legacy_goat_id IS NULL
               AND normalized.sku IS NOT NULL
               AND NULLIF(BTRIM(internal.data->>'sku'), '') = normalized.sku
           ), matches AS MATERIALIZED (
             SELECT normalized.wordpress_product_id,
                    COUNT(DISTINCT candidates.source_product_id)::INTEGER AS candidate_count,
                    MIN(candidates.source_product_id) AS source_product_id,
                    ARRAY_AGG(DISTINCT candidates.method ORDER BY candidates.method)
                      FILTER (WHERE candidates.method IS NOT NULL) AS methods
             FROM normalized
             LEFT JOIN candidates ON candidates.wordpress_product_id = normalized.wordpress_product_id
             GROUP BY normalized.wordpress_product_id
           )
           INSERT INTO wordpress_catalog_run_items
             (run_id, snapshot_id, wordpress_product_id, source_code, source_external_id, legacy_goat_id, sku,
              source_product_id, internal_product_id, match_status, match_method, match_details,
              audit_status, variation_status)
           SELECT $1, snapshots.id, normalized.wordpress_product_id,
                  normalized.identity_source_code, normalized.identity_source_external_id,
                  normalized.legacy_goat_id, normalized.sku,
                  CASE WHEN matches.candidate_count = 1 THEN matches.source_product_id END,
                  CASE WHEN matches.candidate_count = 1 THEN internal.id END,
                  CASE WHEN matches.candidate_count = 0 THEN 'unmatched'
                       WHEN matches.candidate_count = 1 THEN 'matched' ELSE 'ambiguous' END,
                  CASE WHEN matches.candidate_count = 1 THEN ARRAY_TO_STRING(matches.methods, '+') END,
                  JSONB_BUILD_OBJECT('candidate_count', matches.candidate_count, 'methods', COALESCE(TO_JSONB(matches.methods), '[]'::JSONB)),
                  CASE WHEN matches.candidate_count = 1 AND internal.id IS NOT NULL
                         AND (SELECT audit_requested FROM wordpress_catalog_runs WHERE id = $1) AND ${!input.inventoryOnly}
                       THEN 'pending' ELSE 'skipped' END,
                  CASE WHEN matches.candidate_count = 1 AND internal.id IS NOT NULL
                         AND (SELECT variation_sync_requested FROM wordpress_catalog_runs WHERE id = $1) AND ${!input.inventoryOnly}
                       THEN 'pending' ELSE 'skipped' END
           FROM normalized
           JOIN snapshots
             ON snapshots.wordpress_product_id = normalized.wordpress_product_id
            AND snapshots.content_hash = normalized.content_hash
           JOIN matches ON matches.wordpress_product_id = normalized.wordpress_product_id
           LEFT JOIN internal_products internal ON internal.source_product_id = matches.source_product_id
           ON CONFLICT (run_id, wordpress_product_id) DO UPDATE SET
             snapshot_id = EXCLUDED.snapshot_id,
             source_code = EXCLUDED.source_code,
             source_external_id = EXCLUDED.source_external_id,
             legacy_goat_id = EXCLUDED.legacy_goat_id,
             sku = EXCLUDED.sku,
             source_product_id = EXCLUDED.source_product_id,
             internal_product_id = EXCLUDED.internal_product_id,
             match_status = EXCLUDED.match_status,
             match_method = EXCLUDED.match_method,
             match_details = EXCLUDED.match_details,
             updated_at = NOW()
           WHERE ${!input.inventoryOnly}`,
          [input.runId, JSON.stringify(rows), input.fetchedAt],
        );
        await client.query(
          `INSERT INTO wordpress_catalog_item_read_models (
             item_id, run_id, title, search_text, image_url,
             wordpress_variation_count, wordpress_image_count, audit_risk, change_flags, updated_at
           )
           SELECT item.id, item.run_id,
                  COALESCE(snapshot.payload->'product'->>'title', ''),
                  CONCAT_WS(' ', snapshot.payload->'product'->>'title', item.wordpress_product_id::TEXT,
                    item.source_product_id::TEXT, item.internal_product_id::TEXT,
                    item.source_external_id, item.legacy_goat_id, item.sku),
                  COALESCE(snapshot.payload->'product'->'images'->0->>'url',
                    snapshot.payload->'product'->'images'->0->>'source_url',
                    snapshot.payload->'product'->'images'->0->>'origin_url'),
                  JSONB_ARRAY_LENGTH(COALESCE(snapshot.payload->'product'->'variations', '[]'::JSONB)),
                  JSONB_ARRAY_LENGTH(COALESCE(snapshot.payload->'product'->'images', '[]'::JSONB)),
                  CASE WHEN item.audit_status = 'blocked' THEN 'blocked'
                       WHEN item.audit_result->>'risk' IN ('none', 'review', 'danger') THEN item.audit_result->>'risk' END,
                  wordpress_catalog_audit_change_flags(item.audit_result), NOW()
           FROM wordpress_catalog_run_items item
           JOIN wordpress_catalog_snapshots snapshot ON snapshot.id = item.snapshot_id
           WHERE item.run_id = $1 AND item.wordpress_product_id = ANY($2::BIGINT[])
           ON CONFLICT (item_id) DO UPDATE SET
             title = EXCLUDED.title, search_text = EXCLUDED.search_text, image_url = EXCLUDED.image_url,
             wordpress_variation_count = EXCLUDED.wordpress_variation_count,
             wordpress_image_count = EXCLUDED.wordpress_image_count, updated_at = NOW()`,
          [input.runId, input.items.map((item) => item.wordpressProductId)],
        );
      }

      if (input.inventoryOnly) return;
      const nextStatus = input.hasMore ? "running" : "completed";
      await client.query(
        `UPDATE wordpress_catalog_runs
         SET catalog_cursor = $2, catalog_complete = NOT $3, status = $4,
             completed_at = CASE WHEN $3 THEN NULL ELSE NOW() END,
             last_error = NULL, updated_at = NOW()
         WHERE id = $1`,
        [input.runId, input.nextCursor, input.hasMore, nextStatus],
      );
      if (input.hasMore) {
        await client.query(
          `INSERT INTO jobs (job_type, payload, status, unique_key)
           VALUES ('sync_wordpress_catalog', JSONB_BUILD_OBJECT('runId', $1::TEXT, 'cursor', $2::TEXT), 'pending', $3)
           ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry')
           DO NOTHING`,
          [input.runId, input.nextCursor, `wordpress-catalog:${input.runId}:${input.nextCursor}`],
        );
      }
      if (input.items.length > 0) {
        await client.query(
          `INSERT INTO jobs (job_type, payload, status, unique_key)
           SELECT 'prepare_wordpress_variation_patches',
                  JSONB_BUILD_OBJECT('runId', run.id::TEXT, 'afterCursor', $2::TEXT, 'throughCursor', $3::TEXT),
                  'pending', $4
           FROM wordpress_catalog_runs run
           WHERE run.id = $1 AND (run.audit_requested = TRUE OR run.variation_sync_requested = TRUE)
           ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry')
           DO NOTHING`,
          [input.runId, input.expectedCursor, input.nextCursor, `wordpress-variation-prepare:${input.runId}:${input.expectedCursor}:${input.nextCursor}`],
        );
      }
    });
    return (await this.getRun(input.runId))!;
  }

  async listInventoryCandidates(runId: string, afterId: string, limit: number) {
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT target_product.id, target_product.external_id AS wordpress_product_id,
              source.code AS source_code, source_product.external_id AS source_external_id
       FROM wordpress_catalog_runs run
       JOIN target_products target_product ON target_product.target_id = run.target_id
       JOIN internal_products internal ON internal.id = target_product.internal_product_id
       JOIN source_products source_product ON source_product.id = internal.source_product_id
       JOIN sources source ON source.id = source_product.source_id AND source.code = run.source_code
       LEFT JOIN wordpress_catalog_run_items item ON item.run_id = run.id
         AND item.wordpress_product_id = CASE WHEN target_product.external_id ~ '^[0-9]+$' THEN target_product.external_id::BIGINT END
       WHERE run.id = $1 AND target_product.id > $2::BIGINT
         AND target_product.status = 'synced' AND target_product.external_id ~ '^[0-9]+$'
         AND source_product.external_id IS NOT NULL AND item.id IS NULL
       ORDER BY target_product.id LIMIT $3`, [runId, afterId, limit]);
    return result.rows.map((row) => ({ id: text(row, "id"), wordpressProductId: text(row, "wordpress_product_id"),
      sourceCode: text(row, "source_code"), sourceExternalId: text(row, "source_external_id") }));
  }

  async enqueueInventoryReconciliation(runId: string, cursor?: string): Promise<void> {
    await queryPool(this.pool,
      `INSERT INTO jobs(job_type,payload,status,unique_key)
       SELECT 'sync_wordpress_catalog', JSONB_BUILD_OBJECT('runId',$1::TEXT,'cursor',$2::TEXT,'mode','inventory'),
              'pending', 'wordpress-inventory:' || $1::TEXT || ':' || $2::TEXT
       WHERE $3::BOOLEAN OR NOT EXISTS (
         SELECT 1 FROM jobs WHERE job_type='sync_wordpress_catalog' AND payload->>'mode'='inventory'
           AND payload->>'runId'=$1::TEXT AND (status IN ('pending','running','retry','failed') OR created_at > NOW()-INTERVAL '30 minutes')
       )
       ON CONFLICT(job_type,unique_key) WHERE status IN ('pending','running','retry') DO NOTHING`,
      [runId, cursor ?? "0", cursor !== undefined]);
  }

  async getInventoryHealth() {
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT run.id, run.variation_auto_status, COUNT(item.id) AS products,
              COUNT(item.id) FILTER (WHERE item.variation_checked_at IS NULL OR item.variation_checked_at < NOW()-INTERVAL '25 hours') AS overdue,
              COUNT(item.id) FILTER (WHERE item.variation_status='failed') AS failed,
              MAX(item.variation_checked_at) AS last_checked_at
       FROM wordpress_catalog_runs run LEFT JOIN wordpress_catalog_run_items item
         ON item.run_id=run.id AND item.match_status='matched' AND item.internal_product_id IS NOT NULL
       WHERE run.variation_auto_status IN ('running','paused') GROUP BY run.id`);
    return result.rows.map((row) => ({ runId: text(row,"id"), status: text(row,"variation_auto_status"),
      products: Number(row.products), overdue: Number(row.overdue), failed: Number(row.failed), lastCheckedAt: nullableTimestamp(row,"last_checked_at") }));
  }

  async recoverOrphanedVariationItems(runId: string): Promise<number> {
    return transaction(this.pool, async (client) => {
      const selected = await client.query<DatabaseRow>(
        `WITH active_items AS MATERIALIZED (
           SELECT payload->>'itemId' AS id FROM jobs WHERE status IN ('pending','running','retry')
             AND payload->>'runId'=$1::TEXT AND job_type IN ('collect_wordpress_variation_source','prepare_wordpress_variation_patch','refresh_wordpress_variation_patch')
           UNION ALL SELECT JSONB_ARRAY_ELEMENTS_TEXT(payload->'itemIds') FROM jobs
             WHERE status IN ('pending','running','retry') AND payload->>'runId'=$1::TEXT AND job_type='submit_wordpress_variation_patches'
         ), active_polls AS MATERIALIZED (
           SELECT JSONB_ARRAY_ELEMENTS_TEXT(payload->'jobIds') AS id FROM jobs
           WHERE status IN ('pending','running','retry') AND payload->>'runId'=$1::TEXT AND job_type='poll_wordpress_variation_patches'
         )
         SELECT item.id,item.wordpress_product_id,item.wordpress_job_id,item.variation_status
         FROM wordpress_catalog_run_items item
         JOIN wordpress_catalog_runs run ON run.id=item.run_id AND run.variation_auto_status='running'
         WHERE item.run_id=$1::BIGINT AND item.variation_status IN ('pending','refreshing','submitted')
           AND item.updated_at < NOW()-INTERVAL '30 minutes'
           AND NOT EXISTS(SELECT 1 FROM active_items WHERE active_items.id=item.id::TEXT)
           AND NOT EXISTS(SELECT 1 FROM active_polls WHERE active_polls.id=item.wordpress_job_id::TEXT)
         ORDER BY item.id LIMIT 100 FOR UPDATE OF item SKIP LOCKED`, [runId]);
      for (const row of selected.rows) {
        const id = text(row,"id");
        if (text(row,"variation_status") === "submitted" && row.wordpress_job_id !== null) {
          await client.query(`INSERT INTO jobs(job_type,payload,status,unique_key)
            VALUES('poll_wordpress_variation_patches',JSONB_BUILD_OBJECT('runId',$1::TEXT,'jobIds',JSONB_BUILD_ARRAY($2::TEXT),'poll',0),'pending',$3)
            ON CONFLICT(job_type,unique_key) WHERE status IN ('pending','running','retry') DO NOTHING`,
            [runId,text(row,"wordpress_job_id"),`wordpress-inventory-recover-poll:${runId}:${id}`]);
        } else {
          await client.query("UPDATE wordpress_catalog_run_items SET variation_status='pending',updated_at=NOW() WHERE id=$1", [id]);
          await client.query(`INSERT INTO jobs(job_type,payload,status,unique_key)
            VALUES('collect_wordpress_variation_source',JSONB_BUILD_OBJECT('runId',$1::TEXT,'itemId',$2::TEXT,'wordpressProductId',$3::TEXT,'force',TRUE),'pending',$4)
            ON CONFLICT(job_type,unique_key) WHERE status IN ('pending','running','retry') DO NOTHING`,
            [runId,id,text(row,"wordpress_product_id"),`wordpress-variation-collect:${runId}:${id}`]);
        }
      }
      return selected.rows.length;
    });
  }

  async failRun(runId: string, error: string): Promise<void> {
    await queryPool(this.pool,
      `UPDATE wordpress_catalog_runs SET status = 'failed', last_error = $2, completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [runId, error]);
  }

  async listVariationCandidates(input: Parameters<WordPressCatalogRepository["listVariationCandidates"]>[0]): ReturnType<WordPressCatalogRepository["listVariationCandidates"]> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT item.*, snapshot.payload, snapshot.fetched_at,
              source.id AS context_source_id, source.code AS context_source_code, source.config AS context_source_config,
              source_product.source_id AS context_source_product_source_id,
              source_product.source_key AS context_source_key,
              source_product.external_id AS context_source_external_id,
              source_product.slug AS context_source_slug,
              source_product.url AS context_source_url,
              source_product.discovery_metadata AS context_source_metadata,
              target.id AS context_target_id, target.code AS context_target_code, target.config AS context_target_config,
              internal.data AS context_product, internal.content_hash AS context_internal_content_hash
       FROM wordpress_catalog_run_items item
       JOIN wordpress_catalog_snapshots snapshot ON snapshot.id = item.snapshot_id
       JOIN wordpress_catalog_runs run ON run.id = item.run_id
       JOIN targets target ON target.id = run.target_id
       JOIN source_products source_product ON source_product.id = item.source_product_id
       JOIN sources source ON source.id = source_product.source_id
       JOIN internal_products internal ON internal.id = item.internal_product_id
       WHERE item.run_id = $1
         AND item.wordpress_product_id > $2::BIGINT
         AND item.wordpress_product_id <= $3::BIGINT
         AND ($4::BIGINT IS NULL OR item.id = $4::BIGINT)
         AND item.match_status = 'matched'
         AND item.internal_product_id IS NOT NULL
         AND ($4::BIGINT IS NOT NULL OR item.audit_status = 'pending' OR item.variation_status IN ('pending', 'refreshing', 'ready'))
       ORDER BY item.wordpress_product_id`,
      [input.runId, input.afterWordPressProductId, input.throughWordPressProductId, input.itemId ?? null],
    );
    return result.rows.map((row) => ({
      item: mapItem(row),
      source: { id: text(row, "context_source_id"), code: text(row, "context_source_code"), config: row.context_source_config as JsonObject },
      sourceProduct: {
        id: text(row, "source_product_id"),
        sourceId: text(row, "context_source_product_source_id"),
        sourceKey: text(row, "context_source_key"),
        ...(nullableText(row, "context_source_external_id") === null ? {} : { externalId: nullableText(row, "context_source_external_id")! }),
        ...(nullableText(row, "context_source_slug") === null ? {} : { slug: nullableText(row, "context_source_slug")! }),
        ...(nullableText(row, "context_source_url") === null ? {} : { url: nullableText(row, "context_source_url")! }),
        metadata: row.context_source_metadata as JsonObject,
      },
      target: { id: text(row, "context_target_id"), code: text(row, "context_target_code"), config: row.context_target_config as JsonObject },
      product: row.context_product as import("../../../contracts/index.js").UniversalProductDTO,
      internalContentHash: text(row, "context_internal_content_hash"),
    }));
  }

  async saveVariationPreparation(input: Parameters<WordPressCatalogRepository["saveVariationPreparation"]>[0]): Promise<void> {
    await queryPool(this.pool,
       `UPDATE wordpress_catalog_run_items
       SET variation_status = $2, variation_payload = $3::JSONB, variation_notices = $4::JSONB,
            variation_error = $5,
            variation_source_variants = CASE WHEN $2 = 'ready' THEN variation_source_variants ELSE '[]'::JSONB END,
            variation_checked_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [input.itemId, input.status, input.payload === undefined ? null : JSON.stringify(input.payload), JSON.stringify(input.notices), input.error ?? null]);
  }

  async saveVariationSource(input: Parameters<WordPressCatalogRepository["saveVariationSource"]>[0]): Promise<void> {
    await transaction(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `UPDATE wordpress_catalog_run_items
         SET variation_source_hash = $4,
             variation_source_variants = CASE WHEN $6 THEN '[]'::JSONB ELSE $5::JSONB END,
             variation_status = CASE WHEN $6 THEN 'skipped' ELSE 'refreshing' END,
             variation_checked_at = CASE WHEN $6 THEN NOW() ELSE NULL END,
             variation_next_check_at = CASE WHEN $6
               THEN NOW() + INTERVAL '24 hours'
               ELSE NOW() + ((SELECT variation_sync_interval_minutes FROM wordpress_catalog_runs WHERE id = $1) * INTERVAL '1 minute') END,
             variation_unchanged_streak = CASE WHEN $6 THEN variation_unchanged_streak + 1 ELSE 0 END,
             variation_last_changed_at = CASE WHEN $6 THEN variation_last_changed_at ELSE NOW() END,
             variation_error = NULL,
             variation_notices = CASE WHEN $6
               THEN JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT('code', 'unchanged_source', 'message', 'Данные GOAT не изменились'))
               ELSE '[]'::JSONB END,
             updated_at = NOW()
         WHERE run_id = $1 AND id = $2 AND wordpress_product_id = $3::BIGINT
         RETURNING id`,
        [input.runId, input.itemId, input.wordpressProductId, input.sourceHash, JSON.stringify(input.variants), input.unchanged],
      );
      if (result.rows[0] === undefined) return;
      if (!input.unchanged) {
        await client.query(
          `INSERT INTO jobs (job_type, payload, status, unique_key)
           VALUES ('prepare_wordpress_variation_patch',
                   JSONB_BUILD_OBJECT('runId', $1::TEXT, 'itemId', $2::TEXT, 'wordpressProductId', $3::TEXT, 'force', $4::BOOLEAN),
                   'pending', 'wordpress-variation-prepare-item:' || $1::TEXT || ':' || $2::TEXT)
           ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry') DO NOTHING`,
          [input.runId, input.itemId, input.wordpressProductId, input.force === true],
        );
      }
    });
  }

  async listVariationSubmissionItems(runId: string, itemIds: readonly string[]): Promise<readonly WordPressCatalogRunItemRecord[]> {
    if (itemIds.length === 0) return [];
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT item.*, snapshot.payload, snapshot.fetched_at
       FROM wordpress_catalog_run_items item
       JOIN wordpress_catalog_snapshots snapshot ON snapshot.id = item.snapshot_id
       WHERE item.run_id = $1 AND item.id = ANY($2::BIGINT[])
         AND item.variation_status IN ('refreshing', 'submitted') AND item.variation_payload IS NOT NULL
       ORDER BY ARRAY_POSITION($2::BIGINT[], item.id)`,
      [runId, itemIds]);
    return result.rows.map(mapItem);
  }

  async saveVariationSubmission(input: Parameters<WordPressCatalogRepository["saveVariationSubmission"]>[0]): Promise<void> {
    await queryPool(this.pool,
      `UPDATE wordpress_catalog_run_items
       SET variation_status = 'submitted', wordpress_job_id = $2::BIGINT,
           variation_result = $3::JSONB, variation_error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [input.itemId, input.wordpressJobId, JSON.stringify(input.result)]);
  }

  async listSubmittedVariationItems(runId: string, wordpressJobIds: readonly string[]): Promise<readonly WordPressCatalogRunItemRecord[]> {
    if (wordpressJobIds.length === 0) return [];
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT item.*, snapshot.payload, snapshot.fetched_at
       FROM wordpress_catalog_run_items item
       JOIN wordpress_catalog_snapshots snapshot ON snapshot.id = item.snapshot_id
       WHERE item.run_id = $1 AND item.wordpress_job_id = ANY($2::BIGINT[]) AND item.variation_status = 'submitted'
       ORDER BY item.wordpress_job_id`,
      [runId, wordpressJobIds]);
    return result.rows.map(mapItem);
  }

  async saveVariationJobResult(input: Parameters<WordPressCatalogRepository["saveVariationJobResult"]>[0]): Promise<void> {
    await queryPool(this.pool,
      `UPDATE wordpress_catalog_run_items
       SET variation_status = $2, variation_result = $3::JSONB, variation_error = $4,
           variation_applied_source_hash = CASE WHEN $2 = 'completed' THEN variation_source_hash ELSE variation_applied_source_hash END,
           variation_source_variants = CASE WHEN $2 = 'completed' THEN '[]'::JSONB ELSE variation_source_variants END,
           variation_payload = CASE WHEN $2 = 'completed' THEN NULL ELSE variation_payload END,
           variation_checked_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [input.itemId, input.status, JSON.stringify(input.result), input.error ?? null]);
  }

  async saveAudit(input: Parameters<WordPressCatalogRepository["saveAudit"]>[0]): Promise<void> {
    await this.saveAudits([input]);
  }

  async saveAudits(inputs: Parameters<WordPressCatalogRepository["saveAudits"]>[0]): Promise<void> {
    if (inputs.length === 0) return;
    await queryPool(this.pool,
      `WITH input AS MATERIALIZED (
         SELECT item_id, status, result, error
         FROM JSONB_TO_RECORDSET($1::JSONB) AS value(
           item_id BIGINT, status TEXT, result JSONB, error TEXT
         )
       ), saved AS (
         UPDATE wordpress_catalog_run_items item
         SET audit_status = input.status, audit_result = input.result,
             audit_error = input.error, updated_at = NOW()
         FROM input
         WHERE item.id = input.item_id
         RETURNING item.id, input.status, input.result
       )
       UPDATE wordpress_catalog_item_read_models model
       SET audit_risk = CASE WHEN saved.status = 'blocked' THEN 'blocked'
                             WHEN saved.result->>'risk' IN ('none', 'review', 'danger') THEN saved.result->>'risk' END,
           change_flags = wordpress_catalog_audit_change_flags(saved.result), updated_at = NOW()
       FROM saved WHERE model.item_id = saved.id`,
      [JSON.stringify(inputs.map((input) => ({
        item_id: input.itemId,
        status: input.status,
        result: input.result ?? null,
        error: input.error ?? null,
      })))],
    );
  }

  async retryBlockedAudits(runId: string): Promise<{ readonly queuedItemCount: number; readonly queuedJobCount: number }> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `WITH selected AS MATERIALIZED (
         SELECT item.id, item.wordpress_product_id,
                ((ROW_NUMBER() OVER (ORDER BY item.wordpress_product_id) - 1) / 500)::INTEGER AS batch_number
         FROM wordpress_catalog_run_items item
         WHERE item.run_id = $1
           AND item.match_status = 'matched'
           AND item.internal_product_id IS NOT NULL
           AND item.audit_status = 'blocked'
       ), updated AS (
         UPDATE wordpress_catalog_run_items item
         SET audit_status = 'pending', audit_result = NULL, audit_error = NULL, updated_at = NOW()
         FROM selected
         WHERE item.id = selected.id
         RETURNING item.id
       ), reset_models AS (
         UPDATE wordpress_catalog_item_read_models model
         SET audit_risk = NULL, change_flags = '{}'::TEXT[], updated_at = NOW()
         FROM updated
         WHERE model.item_id = updated.id
         RETURNING model.item_id
       ), ranges AS (
         SELECT selected.batch_number,
                (MIN(selected.wordpress_product_id) - 1)::TEXT AS after_cursor,
                MAX(selected.wordpress_product_id)::TEXT AS through_cursor
         FROM selected
         JOIN updated ON updated.id = selected.id
         GROUP BY selected.batch_number
       ), queued AS (
         INSERT INTO jobs (job_type, payload, status, unique_key)
         SELECT 'prepare_wordpress_variation_patches',
                JSONB_BUILD_OBJECT(
                  'runId', $1::TEXT,
                  'afterCursor', ranges.after_cursor,
                  'throughCursor', ranges.through_cursor
                ),
                'pending',
                'wordpress-audit-retry:' || $1::TEXT || ':' || ranges.batch_number::TEXT
         FROM ranges
         ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry')
         DO NOTHING
         RETURNING id
       )
       SELECT (SELECT COUNT(*) FROM updated)::INTEGER AS queued_item_count,
              (SELECT COUNT(*) FROM queued)::INTEGER AS queued_job_count`,
      [runId],
    );
    return {
      queuedItemCount: Number(result.rows[0]?.queued_item_count ?? 0),
      queuedJobCount: Number(result.rows[0]?.queued_job_count ?? 0),
    };
  }

  async rebuildAudits(runId: string, changeFlag?: string): Promise<{ readonly queuedItemCount: number; readonly queuedJobCount: number }> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `WITH selected AS MATERIALIZED (
         SELECT item.id, item.wordpress_product_id,
                ((ROW_NUMBER() OVER (ORDER BY item.wordpress_product_id) - 1) / 500)::INTEGER AS batch_number
         FROM wordpress_catalog_run_items item
         JOIN wordpress_catalog_item_read_models model ON model.item_id = item.id
         WHERE item.run_id = $1
           AND item.match_status = 'matched'
           AND item.internal_product_id IS NOT NULL
           AND ($2::TEXT IS NULL OR $2::TEXT = ANY(model.change_flags))
       ), updated AS (
         UPDATE wordpress_catalog_run_items item
         SET audit_status = 'pending', audit_result = NULL, audit_error = NULL, updated_at = NOW()
         FROM selected
         WHERE item.id = selected.id
         RETURNING item.id
       ), reset_models AS (
         UPDATE wordpress_catalog_item_read_models model
         SET audit_risk = NULL, change_flags = '{}'::TEXT[], updated_at = NOW()
         FROM updated
         WHERE model.item_id = updated.id
         RETURNING model.item_id
       ), ranges AS (
         SELECT selected.batch_number,
                (MIN(selected.wordpress_product_id) - 1)::TEXT AS after_cursor,
                MAX(selected.wordpress_product_id)::TEXT AS through_cursor
         FROM selected
         JOIN updated ON updated.id = selected.id
         GROUP BY selected.batch_number
       ), queued AS (
         INSERT INTO jobs (job_type, payload, status, unique_key)
         SELECT 'prepare_wordpress_variation_patches',
                JSONB_BUILD_OBJECT(
                  'runId', $1::TEXT,
                  'afterCursor', ranges.after_cursor,
                  'throughCursor', ranges.through_cursor
                ),
                'pending',
                'wordpress-audit-rebuild:' || $1::TEXT || ':' || COALESCE($2::TEXT, 'all') || ':' || ranges.batch_number::TEXT
         FROM ranges
         ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry')
         DO NOTHING
         RETURNING id
       )
       SELECT (SELECT COUNT(*) FROM updated)::INTEGER AS queued_item_count,
              (SELECT COUNT(*) FROM queued)::INTEGER AS queued_job_count`,
      [runId, changeFlag ?? null],
    );
    return {
      queuedItemCount: Number(result.rows[0]?.queued_item_count ?? 0),
      queuedJobCount: Number(result.rows[0]?.queued_job_count ?? 0),
    };
  }

  async enqueueVariationItems(runId: string, itemIds: readonly string[]): Promise<number> {
    if (itemIds.length === 0) return 0;
    return transaction(this.pool, async (client) => {
      const updated = await client.query<DatabaseRow>(
        `UPDATE wordpress_catalog_run_items
         SET variation_status = 'pending', variation_error = NULL, updated_at = NOW()
         WHERE run_id = $1 AND id = ANY($2::BIGINT[])
           AND match_status = 'matched' AND internal_product_id IS NOT NULL
           AND variation_status IN ('skipped', 'failed')
         RETURNING id, wordpress_product_id`,
        [runId, itemIds],
      );
      if (updated.rows.length > 0) {
        await client.query(
          `INSERT INTO jobs (job_type, payload, status, unique_key)
           SELECT 'collect_wordpress_variation_source',
                  JSONB_BUILD_OBJECT('runId', $1::TEXT, 'itemId', value.id::TEXT, 'wordpressProductId', value.wordpress_product_id::TEXT, 'force', true),
                  'pending', 'wordpress-variation-collect:' || $1::TEXT || ':' || value.id::TEXT
           FROM JSONB_TO_RECORDSET($2::JSONB) AS value(id BIGINT, wordpress_product_id BIGINT)
           ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry') DO NOTHING`,
          [runId, JSON.stringify(updated.rows)],
        );
      }
      return updated.rows.length;
    });
  }

  async enqueueReadyVariationBatches(runId: string, batchSize: number): Promise<number> {
    return transaction(this.pool, async (client) => {
      const selected = await client.query<DatabaseRow>(
        `WITH selected AS (
           SELECT id
           FROM wordpress_catalog_run_items
           WHERE run_id = $1 AND variation_status = 'ready' AND variation_payload IS NOT NULL
           ORDER BY id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE wordpress_catalog_run_items item
         SET variation_status = 'refreshing', updated_at = NOW()
         FROM selected
         WHERE item.id = selected.id
         RETURNING item.id`,
        [runId, batchSize],
      );
      const itemIds = selected.rows.map((row) => text(row, "id"));
      if (itemIds.length === 0) return 0;
      await client.query(
        `INSERT INTO jobs (job_type, payload, status, unique_key)
         VALUES ('submit_wordpress_variation_patches',
                 JSONB_BUILD_OBJECT('runId', $1::TEXT, 'itemIds', $2::JSONB),
                 'pending', 'wordpress-variation-submit:' || $1::TEXT || ':' || $3::TEXT)
         ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry') DO NOTHING`,
        [runId, JSON.stringify(itemIds), itemIds[0]],
      );
      return itemIds.length;
    });
  }

  async failVariationItems(runId: string, itemIds: readonly string[], error: string): Promise<void> {
    if (itemIds.length === 0) return;
    await queryPool(this.pool,
      `UPDATE wordpress_catalog_run_items
       SET variation_status = 'failed', variation_error = $3, variation_checked_at = NOW(), updated_at = NOW()
       WHERE run_id = $1 AND id = ANY($2::BIGINT[])`,
      [runId, itemIds, error]);
  }

  async isVariationAutoSyncRunning(runId: string): Promise<boolean> {
    const result = await queryPool<DatabaseRow>(this.pool,
      "SELECT variation_auto_status = 'running' AS is_running FROM wordpress_catalog_runs WHERE id = $1",
      [runId]);
    return result.rows[0]?.is_running === true;
  }

  async getActiveVariationSync(): Promise<WordPressVariationAutoSyncState | null> {
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT run.id AS run_id, run.variation_auto_window,
              run.variation_auto_acknowledged_failed_count,
              run.variation_sync_interval_minutes, run.variation_sync_cycle,
              run.variation_sync_next_cycle_at,
               (SELECT COUNT(*) FROM wordpress_catalog_run_items item
                WHERE item.run_id = run.id AND item.variation_sync_cycle = run.variation_sync_cycle
                  AND item.variation_status IN ('pending', 'refreshing', 'ready', 'submitted')) AS active_count,
               (SELECT COUNT(*) FROM wordpress_catalog_run_items item
                WHERE item.run_id = run.id AND item.variation_sync_cycle = run.variation_sync_cycle
                  AND item.variation_status = 'failed') AS failed_count
       FROM wordpress_catalog_runs run
       WHERE run.variation_auto_status IN ('running', 'paused')
       LIMIT 1`);
    const row = result.rows[0];
    return row === undefined ? null : {
      runId: text(row, "run_id"),
      window: Number(row.variation_auto_window),
      acknowledgedFailedCount: Number(row.variation_auto_acknowledged_failed_count),
      activeCount: Number(row.active_count),
      failedCount: Number(row.failed_count),
      intervalMinutes: Number(row.variation_sync_interval_minutes),
      cycle: Number(row.variation_sync_cycle),
      nextCycleAt: nullableTimestamp(row, "variation_sync_next_cycle_at"),
    };
  }

  async startVariationAutoSync(runId: string, window: number, intervalMinutes: number): Promise<void> {
    await transaction(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `UPDATE wordpress_catalog_runs AS run
         SET variation_sync_requested = TRUE,
             variation_auto_status = 'running', variation_auto_window = $2,
             variation_sync_interval_minutes = $3,
             variation_auto_acknowledged_failed_count = 0,
             variation_auto_error = NULL,
             variation_auto_started_at = COALESCE(variation_auto_started_at, NOW()),
             variation_auto_completed_at = NULL,
             variation_sync_cycle = variation_sync_cycle + 1,
             variation_sync_last_cycle_started_at = NOW(),
             variation_sync_last_cycle_completed_at = NULL,
             variation_sync_next_cycle_at = NULL,
             variation_discovery_job_id = NULL,
             variation_discovery_completed_at = NULL,
             updated_at = NOW()
         WHERE run.id = $1 RETURNING run.id, run.source_code, run.variation_sync_cycle`,
         [runId, window, intervalMinutes],
       );
      const run = result.rows[0];
      if (run === undefined) throw new Error(`WordPress catalog run not found: ${runId}`);
      const source = await client.query<DatabaseRow>("SELECT id FROM sources WHERE code = $1 AND enabled = TRUE ORDER BY id LIMIT 1", [text(run, "source_code")]);
      const sourceId = source.rows[0] === undefined ? null : text(source.rows[0], "id");
      if (sourceId === null) throw new Error(`Enabled source not found: ${text(run, "source_code")}`);
      const discovery = await client.query<DatabaseRow>(
        `INSERT INTO jobs (job_type, payload, status, unique_key)
         VALUES ('discover_source',
                 JSONB_BUILD_OBJECT('sourceId', $2::TEXT, 'runType', 'inventory_refresh', 'coverage', 'full', 'enqueueCollection', FALSE, 'enqueueNewCollection', TRUE),
                 'pending', 'wordpress-variation-discovery:' || $1::TEXT || ':' || $3::TEXT)
         RETURNING id`,
        [runId, sourceId, text(run, "variation_sync_cycle")],
      );
      await client.query("UPDATE wordpress_catalog_runs SET variation_discovery_job_id = $2 WHERE id = $1", [runId, text(discovery.rows[0]!, "id")]);
    });
  }

  async replenishVariationAutoSync(): Promise<WordPressVariationAutoTickOutcome> {
    return transaction(this.pool, async (client) => {
      const activeRun = await client.query<DatabaseRow>(
        `SELECT id, source_code, variation_auto_window, variation_auto_acknowledged_failed_count,
                variation_sync_interval_minutes, variation_sync_next_cycle_at, variation_sync_cycle,
                variation_discovery_job_id, variation_discovery_completed_at
         FROM wordpress_catalog_runs
         WHERE variation_auto_status = 'running'
         LIMIT 1
         FOR UPDATE`,
      );
      const run = activeRun.rows[0];
      if (run === undefined) return "idle";
      const runId = text(run, "id");
      const nextCycleAt = nullableTimestamp(run, "variation_sync_next_cycle_at");
      if (nextCycleAt !== null) {
        if (new Date(nextCycleAt).valueOf() > Date.now()) return "waiting";
        const next = await client.query<DatabaseRow>(
          `UPDATE wordpress_catalog_runs
           SET variation_sync_cycle = variation_sync_cycle + 1,
               variation_sync_last_cycle_started_at = NOW(),
               variation_sync_last_cycle_completed_at = NULL,
               variation_sync_next_cycle_at = NULL, variation_auto_error = NULL,
               variation_discovery_job_id = NULL, variation_discovery_completed_at = NULL,
               updated_at = NOW()
           WHERE id = $1
           RETURNING variation_sync_cycle`,
          [runId],
        );
        const source = await client.query<DatabaseRow>("SELECT id FROM sources WHERE code = $1 AND enabled = TRUE ORDER BY id LIMIT 1", [text(run, "source_code")]);
        if (source.rows[0] === undefined) throw new Error(`Enabled source not found: ${text(run, "source_code")}`);
        const discovery = await client.query<DatabaseRow>(
          `INSERT INTO jobs (job_type, payload, status, unique_key)
           VALUES ('discover_source',
                   JSONB_BUILD_OBJECT('sourceId', $2::TEXT, 'runType', 'inventory_refresh', 'coverage', 'full', 'enqueueCollection', FALSE, 'enqueueNewCollection', FALSE),
                   'pending', 'wordpress-variation-discovery:' || $1::TEXT || ':' || $3::TEXT)
           RETURNING id`,
          [runId, text(source.rows[0], "id"), text(next.rows[0]!, "variation_sync_cycle")],
        );
        await client.query("UPDATE wordpress_catalog_runs SET variation_discovery_job_id = $2 WHERE id = $1", [runId, text(discovery.rows[0]!, "id")]);
        return "cycle_started";
      }
      let discoveryComplete = run.variation_discovery_completed_at !== null && run.variation_discovery_completed_at !== undefined;
      if (!discoveryComplete) {
        const discoveryJobId = nullableText(run, "variation_discovery_job_id");
        if (discoveryJobId === null) throw new Error(`Inventory discovery job is missing for run ${runId}`);
        const discovery = await client.query<DatabaseRow>("SELECT status, last_error FROM jobs WHERE id = $1", [discoveryJobId]);
        const discoveryJob = discovery.rows[0];
        if (discoveryJob === undefined) throw new Error(`Inventory discovery job ${discoveryJobId} is missing`);
        const discoveryStatus = text(discoveryJob, "status");
        if (discoveryStatus === "failed") {
          await client.query(
            `UPDATE wordpress_catalog_runs
             SET variation_auto_status = 'paused', variation_auto_error = $2, updated_at = NOW()
             WHERE id = $1`,
            [runId, nullableText(discoveryJob, "last_error") ?? "Обновление sitemap завершилось с ошибкой"],
          );
          return "paused";
        }
        if (discoveryStatus === "completed") {
          await client.query("UPDATE wordpress_catalog_runs SET variation_discovery_completed_at = NOW(), updated_at = NOW() WHERE id = $1", [runId]);
          discoveryComplete = true;
        }
      }
      const counts = await client.query<DatabaseRow>(
        `SELECT (SELECT COUNT(*) FROM wordpress_catalog_run_items
                 WHERE run_id = $1 AND variation_sync_cycle = $2::BIGINT
                   AND variation_status IN ('pending', 'refreshing', 'ready', 'submitted')) AS active_count,
                (SELECT COUNT(*) FROM wordpress_catalog_run_items
                 WHERE run_id = $1 AND variation_sync_cycle = $2::BIGINT AND variation_status = 'failed') AS failed_count`,
        [runId, text(run, "variation_sync_cycle")],
      );
      const activeCount = Number(counts.rows[0]?.active_count ?? 0);
      const failedCount = Number(counts.rows[0]?.failed_count ?? 0);
      if (failedCount > Number(run.variation_auto_acknowledged_failed_count)) {
        await client.query(
          `UPDATE wordpress_catalog_runs
           SET variation_auto_status = 'paused',
               variation_auto_error = 'Постоянное обновление остановлено после ошибки товара. Проверьте журнал и возобновите вручную.',
               updated_at = NOW()
           WHERE id = $1`,
          [runId],
        );
        return "paused";
      }
      const available = Math.max(0, Number(run.variation_auto_window) - activeCount);
      if (available === 0) return "waiting";
      const updated = await client.query<DatabaseRow>(
         `WITH selected AS (
            SELECT item.id
            FROM wordpress_catalog_run_items item
            JOIN source_products source_product ON source_product.id = item.source_product_id
            WHERE item.run_id = $1 AND item.match_status = 'matched' AND item.internal_product_id IS NOT NULL
              AND (
                (item.variation_sync_cycle < $3::BIGINT AND item.variation_next_check_at <= NOW())
                OR source_product.discovery_changed_at > COALESCE(item.variation_checked_at, '-infinity'::TIMESTAMPTZ)
              )
            ORDER BY (source_product.discovery_changed_at > COALESCE(item.variation_checked_at, '-infinity'::TIMESTAMPTZ)) DESC,
                     item.variation_next_check_at,
                     source_product.discovery_changed_at DESC NULLS LAST,
                     source_product.first_seen_at DESC,
                     item.id
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          UPDATE wordpress_catalog_run_items AS item
          SET variation_status = 'pending', variation_payload = NULL, variation_notices = '[]'::JSONB,
              wordpress_job_id = NULL, variation_result = NULL, variation_error = NULL,
              variation_source_variants = '[]'::JSONB, variation_source_hash = NULL,
              variation_checked_at = NULL, variation_sync_cycle = $3::BIGINT, updated_at = NOW()
         FROM selected
         WHERE item.id = selected.id
         RETURNING item.id, item.wordpress_product_id`,
        [runId, available, text(run, "variation_sync_cycle")],
      );
      if (updated.rows.length > 0) {
        await client.query(
          `INSERT INTO jobs (job_type, payload, status, unique_key)
            SELECT 'collect_wordpress_variation_source',
                   JSONB_BUILD_OBJECT('runId', $1::TEXT, 'itemId', value.id::TEXT, 'wordpressProductId', value.wordpress_product_id::TEXT),
                   'pending', 'wordpress-variation-collect:' || $1::TEXT || ':' || value.id::TEXT
           FROM JSONB_TO_RECORDSET($2::JSONB) AS value(id BIGINT, wordpress_product_id BIGINT)
           ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry') DO NOTHING`,
          [runId, JSON.stringify(updated.rows)],
        );
        return "queued";
      }
      if (activeCount > 0) return "waiting";
      if (!discoveryComplete) return "waiting";
      await client.query(
        `UPDATE wordpress_catalog_runs
         SET variation_auto_error = NULL,
             variation_sync_last_cycle_completed_at = NOW(),
             variation_sync_next_cycle_at = NOW() + (variation_sync_interval_minutes * INTERVAL '1 minute'),
             updated_at = NOW()
         WHERE id = $1`,
        [runId],
      );
      return nextCycleAt === null ? "cycle_completed" : "cycle_started";
    });
  }

  async setVariationAutoSyncStatus(input: {
    readonly runId: string;
    readonly status: "running" | "paused" | "inactive";
    readonly error?: string;
    readonly acknowledgeFailures?: number;
  }): Promise<void> {
    await transaction(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `UPDATE wordpress_catalog_runs
         SET variation_auto_status = $2,
             variation_auto_error = $3,
             variation_auto_acknowledged_failed_count = COALESCE($4, variation_auto_acknowledged_failed_count),
             variation_auto_completed_at = CASE WHEN $2 = 'inactive' THEN NOW() ELSE NULL END,
             variation_sync_next_cycle_at = CASE WHEN $2 = 'inactive' THEN NULL ELSE variation_sync_next_cycle_at END,
             updated_at = NOW()
         WHERE id = $1 RETURNING id`,
        [input.runId, input.status, input.error ?? null, input.acknowledgeFailures ?? null],
      );
      if (result.rows[0] === undefined) throw new Error(`WordPress catalog run not found: ${input.runId}`);
      if (input.status === "running" && input.acknowledgeFailures !== undefined) {
        await client.query(
          `UPDATE wordpress_catalog_run_items
           SET variation_status = 'skipped', variation_payload = NULL, variation_notices = '[]'::JSONB,
               wordpress_job_id = NULL, variation_result = NULL, variation_error = NULL,
               variation_checked_at = NULL,
               variation_sync_cycle = GREATEST(0, variation_sync_cycle - 1), updated_at = NOW()
           WHERE run_id = $1 AND variation_status = 'failed'`,
          [input.runId],
        );
      }
    });
  }

}
