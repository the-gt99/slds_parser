import type { JsonObject } from "../../../contracts/index.js";
import type {
  WordPressCatalogRepository,
  WordPressCatalogRunItemRecord,
  WordPressCatalogRunRecord,
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
    variationSubmittedCount: Number(row.variation_submitted_count ?? 0),
    variationCompletedCount: Number(row.variation_completed_count ?? 0),
    variationSkippedCount: Number(row.variation_skipped_count ?? 0),
    variationFailedCount: Number(row.variation_failed_count ?? 0),
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
    payload: row.payload as JsonObject,
    fetchedAt: timestamp(row, "fetched_at"),
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
         ,COUNT(item.id) FILTER (WHERE item.variation_status = 'submitted')::BIGINT AS variation_submitted_count
         ,COUNT(item.id) FILTER (WHERE item.variation_status = 'completed')::BIGINT AS variation_completed_count
         ,COUNT(item.id) FILTER (WHERE item.variation_status = 'skipped')::BIGINT AS variation_skipped_count
         ,COUNT(item.id) FILTER (WHERE item.variation_status = 'failed')::BIGINT AS variation_failed_count
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
      `${runSelect} WHERE run.target_id = $1 GROUP BY run.id, target.name ORDER BY run.created_at DESC, run.id DESC LIMIT $2`,
      [targetId, limit],
    );
    return result.rows.map(mapRun);
  }

  async listItems(input: Parameters<WordPressCatalogRepository["listItems"]>[0]): Promise<{ readonly items: readonly WordPressCatalogRunItemRecord[]; readonly total: number }> {
    const parameters: unknown[] = [input.runId];
    const where = ["item.run_id = $1"];
    if (input.matchStatus !== undefined) {
      parameters.push(input.matchStatus);
      where.push(`item.match_status = $${parameters.length}`);
    }
    parameters.push(input.limit, input.offset);
    const result = await queryPool<DatabaseRow>(this.pool,
      `SELECT item.*, snapshot.payload, snapshot.fetched_at, COUNT(*) OVER()::BIGINT AS total
       FROM wordpress_catalog_run_items item
       JOIN wordpress_catalog_snapshots snapshot ON snapshot.id = item.snapshot_id
       WHERE ${where.join(" AND ")}
       ORDER BY item.wordpress_product_id ASC
       LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    );
    return { items: result.rows.map(mapItem), total: Number(result.rows[0]?.total ?? 0) };
  }

  async savePage(input: Parameters<WordPressCatalogRepository["savePage"]>[0]): Promise<WordPressCatalogRunRecord> {
    await transaction(this.pool, async (client) => {
      const locked = await client.query<DatabaseRow>(
        `SELECT id, catalog_cursor, status FROM wordpress_catalog_runs WHERE id = $1 FOR UPDATE`, [input.runId]);
      const run = locked.rows[0];
      if (run === undefined) throw new Error(`WordPress catalog run not found: ${input.runId}`);
      if (text(run, "status") !== "running") throw new Error(`WordPress catalog run is not running: ${input.runId}`);
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
                         AND (SELECT audit_requested FROM wordpress_catalog_runs WHERE id = $1)
                       THEN 'pending' ELSE 'skipped' END,
                  CASE WHEN matches.candidate_count = 1 AND internal.id IS NOT NULL
                         AND (SELECT variation_sync_requested FROM wordpress_catalog_runs WHERE id = $1)
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
             updated_at = NOW()`,
          [input.runId, JSON.stringify(rows), input.fetchedAt],
        );
      }

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
         AND item.match_status = 'matched'
         AND item.internal_product_id IS NOT NULL
         AND (item.audit_status = 'pending' OR item.variation_status IN ('pending', 'ready'))
       ORDER BY item.wordpress_product_id`,
      [input.runId, input.afterWordPressProductId, input.throughWordPressProductId],
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
           variation_error = $5, variation_checked_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [input.itemId, input.status, input.payload === undefined ? null : JSON.stringify(input.payload), JSON.stringify(input.notices), input.error ?? null]);
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
           variation_checked_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [input.itemId, input.status, JSON.stringify(input.result), input.error ?? null]);
  }

  async saveAudit(input: Parameters<WordPressCatalogRepository["saveAudit"]>[0]): Promise<void> {
    await queryPool(this.pool,
      `UPDATE wordpress_catalog_run_items
       SET audit_status = $2, audit_result = $3::JSONB, audit_error = $4, updated_at = NOW()
       WHERE id = $1`,
      [input.itemId, input.status, input.result === undefined ? null : JSON.stringify(input.result), input.error ?? null]);
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
           SELECT 'refresh_wordpress_variation_patch',
                  JSONB_BUILD_OBJECT('runId', $1::TEXT, 'itemId', value.id::TEXT, 'wordpressProductId', value.wordpress_product_id::TEXT),
                  'pending', 'wordpress-variation-refresh:' || $1::TEXT || ':' || value.id::TEXT
           FROM JSONB_TO_RECORDSET($2::JSONB) AS value(id BIGINT, wordpress_product_id BIGINT)
           ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry') DO NOTHING`,
          [runId, JSON.stringify(updated.rows)],
        );
      }
      return updated.rows.length;
    });
  }

  async enableVariationSync(runId: string): Promise<number> {
    return transaction(this.pool, async (client) => {
      const run = await client.query<DatabaseRow>(
        `UPDATE wordpress_catalog_runs SET variation_sync_requested = TRUE, updated_at = NOW() WHERE id = $1 RETURNING id`, [runId]);
      if (run.rows[0] === undefined) throw new Error(`WordPress catalog run not found: ${runId}`);
      const updated = await client.query<DatabaseRow>(
        `UPDATE wordpress_catalog_run_items
         SET variation_status = 'pending', variation_error = NULL, updated_at = NOW()
         WHERE run_id = $1 AND match_status = 'matched' AND internal_product_id IS NOT NULL
           AND variation_status IN ('skipped', 'failed')
         RETURNING id, wordpress_product_id`,
        [runId],
      );
      if (updated.rows.length > 0) {
        await client.query(
          `INSERT INTO jobs (job_type, payload, status, unique_key)
           SELECT 'refresh_wordpress_variation_patch',
                  JSONB_BUILD_OBJECT('runId', $1::TEXT, 'itemId', value.id::TEXT, 'wordpressProductId', value.wordpress_product_id::TEXT),
                  'pending', 'wordpress-variation-refresh:' || $1::TEXT || ':' || value.id::TEXT
           FROM JSONB_TO_RECORDSET($2::JSONB) AS value(id BIGINT, wordpress_product_id BIGINT)
           ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry') DO NOTHING`,
          [runId, JSON.stringify(updated.rows)],
        );
      }
      return updated.rows.length;
    });
  }

  async enqueueVariationBatch(runId: string, limit: number): Promise<number> {
    return transaction(this.pool, async (client) => {
      const updated = await client.query<DatabaseRow>(
        `WITH selected AS (
           SELECT id
           FROM wordpress_catalog_run_items
           WHERE run_id = $1 AND match_status = 'matched' AND internal_product_id IS NOT NULL
             AND variation_status IN ('skipped', 'failed')
           ORDER BY id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE wordpress_catalog_run_items AS item
         SET variation_status = 'pending', variation_error = NULL, updated_at = NOW()
         FROM selected
         WHERE item.id = selected.id
         RETURNING item.id, item.wordpress_product_id`,
        [runId, limit],
      );
      if (updated.rows.length > 0) {
        await client.query(
          `INSERT INTO jobs (job_type, payload, status, unique_key)
           SELECT 'refresh_wordpress_variation_patch',
                  JSONB_BUILD_OBJECT('runId', $1::TEXT, 'itemId', value.id::TEXT, 'wordpressProductId', value.wordpress_product_id::TEXT),
                  'pending', 'wordpress-variation-refresh:' || $1::TEXT || ':' || value.id::TEXT
           FROM JSONB_TO_RECORDSET($2::JSONB) AS value(id BIGINT, wordpress_product_id BIGINT)
           ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry') DO NOTHING`,
          [runId, JSON.stringify(updated.rows)],
        );
      }
      return updated.rows.length;
    });
  }
}
