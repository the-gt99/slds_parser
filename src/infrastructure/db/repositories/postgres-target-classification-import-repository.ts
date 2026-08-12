import { IntegrationContractError } from "../../../core/errors/index.js";
import type {
  EntityId,
  JsonObject,
} from "../../../contracts/index.js";
import type {
  TargetClassificationImportRepository,
  TargetClassificationSuggestion,
  TargetClassificationSuggestionExample,
  TargetClassificationSuggestionQuery,
  TargetClassificationSuggestionResult,
  TargetClassificationSyncRun,
} from "../../../repositories/index.js";
import type { SqlClient, SqlPool } from "../sql-executor.js";
import type { DatabaseRow } from "./row-mappers.js";

function text(row: DatabaseRow, key: string): string { return String(row[key]); }
function nullableText(row: DatabaseRow, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : String(row[key]);
}
function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp(value);
}

function mapRun(row: DatabaseRow): TargetClassificationSyncRun {
  return {
    id: text(row, "id"),
    targetId: text(row, "target_id"),
    targetCode: text(row, "target_code"),
    targetName: text(row, "target_name"),
    targetEnabled: row.target_enabled === true,
    sourceId: text(row, "source_id"),
    sourceCode: text(row, "source_code"),
    sourceName: text(row, "source_name"),
    status: text(row, "status") as TargetClassificationSyncRun["status"],
    cursor: text(row, "cursor"),
    fetchedProductCount: Number(row.fetched_product_count),
    matchedSourceProductCount: Number(row.matched_source_product_count),
    assignmentCount: Number(row.assignment_count),
    suggestionCount: Number(row.suggestion_count),
    readySuggestionCount: Number(row.ready_suggestion_count),
    conflictSuggestionCount: Number(row.conflict_suggestion_count),
    requestedBy: text(row, "requested_by"),
    startedAt: nullableTimestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    lastError: nullableText(row, "last_error"),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function targets(value: unknown): TargetClassificationSuggestion["targets"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      dictionaryValueId: row.dictionaryValueId === null || row.dictionaryValueId === undefined ? null : String(row.dictionaryValueId),
      externalValue: String(row.externalValue ?? ""),
      name: String(row.name ?? ""),
      productCount: Number(row.productCount ?? 0),
    };
  });
}

function mapSuggestion(row: DatabaseRow): TargetClassificationSuggestion {
  return {
    id: text(row, "id"),
    runId: text(row, "run_id"),
    targetId: text(row, "target_id"),
    sourceId: text(row, "source_id"),
    typeCode: text(row, "type_code"),
    suggestionKind: text(row, "suggestion_kind") as TargetClassificationSuggestion["suggestionKind"],
    scope: text(row, "scope"),
    normalizedSourceValue: text(row, "normalized_source_value"),
    contextKey: text(row, "context_key"),
    context: row.context as JsonObject,
    sourceValue: text(row, "source_value"),
    targetScope: text(row, "target_scope"),
    dictionaryValueId: nullableText(row, "dictionary_value_id"),
    externalValue: nullableText(row, "external_value"),
    targetName: nullableText(row, "target_name"),
    matchedProductCount: Number(row.matched_product_count),
    evidenceProductCount: Number(row.evidence_product_count),
    missingTargetCount: Number(row.missing_target_count),
    targets: targets(row.target_counts),
    status: text(row, "status") as TargetClassificationSuggestion["status"],
    issueReason: nullableText(row, "issue_reason"),
    appliedResolutionKind: nullableText(row, "applied_resolution_kind") as TargetClassificationSuggestion["appliedResolutionKind"],
    appliedResolutionId: nullableText(row, "applied_resolution_id"),
  };
}

function mapExample(row: DatabaseRow): TargetClassificationSuggestionExample {
  return {
    sourceProductId: text(row, "source_product_id"),
    sourceExternalId: text(row, "source_external_id"),
    targetExternalId: text(row, "target_external_id"),
    title: text(row, "title"),
    sourceUrl: nullableText(row, "source_url"),
    termExternalValue: nullableText(row, "term_external_value"),
    termName: nullableText(row, "term_name"),
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

const runSelect = `SELECT run.*, target.code AS target_code, target.name AS target_name,
  target.enabled AS target_enabled, source.code AS source_code, source.name AS source_name
  FROM target_classification_sync_runs run
  JOIN targets target ON target.id = run.target_id
  JOIN sources source ON source.id = run.source_id`;

async function buildSuggestions(client: SqlClient, runId: EntityId): Promise<void> {
  await client.query("DELETE FROM target_classification_suggestions WHERE run_id = $1", [runId]);
  await client.query(
    `WITH capabilities(type_code, taxonomy, entity_type, target_scope) AS (
       VALUES
         ('brand'::TEXT, 'pa_brand'::TEXT, 'brands'::TEXT, 'product.brand'::TEXT),
         ('model', 'pa_model', 'models', 'product.model'),
         ('category', 'product_cat', 'product_categories', 'product.category')
     ), imported_terms AS MATERIALIZED (
       SELECT imported.source_product_id, capability.type_code, capability.target_scope,
              term->>'term_id' AS external_value,
              COALESCE(NULLIF(term->>'name', ''), term->>'term_id') AS target_name,
              dictionary.id AS dictionary_value_id
       FROM target_classification_import_products imported
       CROSS JOIN LATERAL JSONB_EACH(imported.taxonomies) taxonomy
       JOIN capabilities capability ON capability.taxonomy = taxonomy.key
       CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(taxonomy.value) term
       JOIN target_classification_sync_runs run ON run.id = imported.run_id
       LEFT JOIN target_dictionary_values dictionary
         ON dictionary.target_id = run.target_id
        AND dictionary.entity_type = capability.entity_type
        AND dictionary.external_id = term->>'term_id'
        AND dictionary.active = TRUE
       WHERE imported.run_id = $1
         AND imported.source_product_id IS NOT NULL
         AND NULLIF(term->>'term_id', '') IS NOT NULL
     ), observations AS MATERIALIZED (
       SELECT type.code AS type_code,
              CASE WHEN type.code = 'model' THEN 'rule' ELSE 'mapping' END AS suggestion_kind,
              CASE WHEN type.code = 'model' THEN candidate.context_key ELSE candidate.id::TEXT END AS group_key,
              candidate.scope,
              CASE WHEN type.code = 'model' THEN '' ELSE candidate.normalized_source_value END AS normalized_source_value,
              candidate.context_key,
              candidate.context,
              CASE WHEN type.code = 'model'
                THEN CONCAT_WS(' · ', NULLIF(candidate.context->>'brand', ''), NULLIF(candidate.context->>'family', ''))
                ELSE candidate.normalized_source_value END AS source_value,
              capability.target_scope,
              link.source_product_id,
              imported.external_value,
              imported.target_name,
              imported.dictionary_value_id
       FROM source_product_classification_links link
       JOIN classification_candidates candidate ON candidate.id = link.candidate_id
       JOIN reference_types type ON type.id = candidate.reference_type_id
       JOIN capabilities capability ON capability.type_code = type.code
       JOIN target_classification_import_products product
         ON product.run_id = $1 AND product.source_product_id = link.source_product_id
       LEFT JOIN imported_terms imported
         ON imported.source_product_id = link.source_product_id
        AND imported.type_code = type.code
       WHERE link.active = TRUE
         AND link.status IN ('unresolved', 'ambiguous')
         AND (type.code <> 'model'
           OR (NULLIF(candidate.context->>'brand', '') IS NOT NULL
             AND NULLIF(candidate.context->>'family', '') IS NOT NULL))
     ), product_evidence AS MATERIALIZED (
       SELECT type_code, suggestion_kind, group_key, scope, normalized_source_value,
              context_key, context, source_value, target_scope, source_product_id,
              COUNT(DISTINCT external_value) AS term_count
       FROM observations
       GROUP BY type_code, suggestion_kind, group_key, scope, normalized_source_value,
                context_key, context, source_value, target_scope, source_product_id
     ), group_summary AS MATERIALIZED (
       SELECT type_code, suggestion_kind, group_key, scope, normalized_source_value,
              context_key, context, source_value, target_scope,
              COUNT(*)::BIGINT AS matched_product_count,
              COUNT(*) FILTER (WHERE term_count > 0)::BIGINT AS evidence_product_count,
              COUNT(*) FILTER (WHERE term_count = 0)::BIGINT AS missing_target_count,
              COUNT(*) FILTER (WHERE term_count > 1)::BIGINT AS multi_target_product_count
       FROM product_evidence
       GROUP BY type_code, suggestion_kind, group_key, scope, normalized_source_value,
                context_key, context, source_value, target_scope
     ), target_totals AS MATERIALIZED (
       SELECT type_code, group_key, external_value,
              MAX(target_name) AS target_name,
              MAX(dictionary_value_id) AS dictionary_value_id,
              COUNT(DISTINCT source_product_id)::BIGINT AS product_count
       FROM observations
       WHERE external_value IS NOT NULL
       GROUP BY type_code, group_key, external_value
     ), target_aggregates AS MATERIALIZED (
       SELECT type_code, group_key,
              COUNT(*)::INTEGER AS target_count,
              COUNT(dictionary_value_id)::INTEGER AS dictionary_count,
              MAX(dictionary_value_id) AS dictionary_value_id,
              MAX(external_value) AS external_value,
              MAX(target_name) AS target_name,
              JSONB_AGG(JSONB_BUILD_OBJECT(
                'dictionaryValueId', dictionary_value_id::TEXT,
                'externalValue', external_value,
                'name', target_name,
                'productCount', product_count
              ) ORDER BY product_count DESC, target_name, external_value) AS target_counts
       FROM target_totals
       GROUP BY type_code, group_key
     ), inserted AS (
       INSERT INTO target_classification_suggestions (
         run_id, target_id, source_id, type_code, suggestion_kind, group_key,
         scope, normalized_source_value, context_key, context, source_value,
         target_scope, dictionary_value_id, external_value, target_name,
         matched_product_count, evidence_product_count, missing_target_count,
         target_counts, status, issue_reason
       )
       SELECT run.id, run.target_id, run.source_id, summary.type_code,
              summary.suggestion_kind, summary.group_key, summary.scope,
              summary.normalized_source_value, summary.context_key, summary.context,
              summary.source_value, summary.target_scope,
              aggregate.dictionary_value_id, aggregate.external_value, aggregate.target_name,
              summary.matched_product_count, summary.evidence_product_count,
              summary.missing_target_count, COALESCE(aggregate.target_counts, '[]'::JSONB),
              CASE WHEN aggregate.target_count = 1 AND aggregate.dictionary_count = 1
                     AND summary.multi_target_product_count = 0
                   THEN 'ready' ELSE 'conflict' END,
              CASE
                WHEN COALESCE(aggregate.target_count, 0) = 0 THEN 'target_term_missing_on_products'
                WHEN aggregate.target_count > 1 OR summary.multi_target_product_count > 0 THEN 'target_terms_conflict'
                WHEN aggregate.dictionary_count <> 1 THEN 'target_dictionary_value_missing'
                ELSE NULL
              END
       FROM group_summary summary
       JOIN target_classification_sync_runs run ON run.id = $1
       LEFT JOIN target_aggregates aggregate
         ON aggregate.type_code = summary.type_code AND aggregate.group_key = summary.group_key
       RETURNING status, matched_product_count
     )
     UPDATE target_classification_sync_runs run
     SET status = 'completed', finished_at = NOW(), last_error = NULL,
         suggestion_count = (SELECT COUNT(*) FROM inserted),
         ready_suggestion_count = (SELECT COUNT(*) FROM inserted WHERE status = 'ready'),
         conflict_suggestion_count = (SELECT COUNT(*) FROM inserted WHERE status = 'conflict'),
         updated_at = NOW()
     WHERE run.id = $1`,
    [runId],
  );
}

export class PostgresTargetClassificationImportRepository implements TargetClassificationImportRepository {
  constructor(private readonly pool: SqlPool) {}

  async createRun(targetId: EntityId, sourceId: EntityId, actor: string): Promise<TargetClassificationSyncRun> {
    const runId = await transaction(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `INSERT INTO target_classification_sync_runs (target_id, source_id, status, requested_by)
         VALUES ($1, $2, 'pending', $3)
         RETURNING id`,
        [targetId, sourceId, actor],
      );
      const id = text(result.rows[0]!, "id");
      await client.query(
        `INSERT INTO jobs (job_type, payload, status, available_at, unique_key)
         VALUES ('sync_target_classifications', JSONB_BUILD_OBJECT('runId', $1::TEXT, 'cursor', '0'), 'pending', NOW(), $2)`,
        [id, `target-classification-sync:${id}:0`],
      );
      return id;
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === "23505") {
        throw new IntegrationContractError("Синхронизация этого source и target уже выполняется");
      }
      throw error;
    });
    return (await this.getRun(runId))!;
  }

  async getRun(runId: EntityId): Promise<TargetClassificationSyncRun | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<DatabaseRow>(`${runSelect} WHERE run.id = $1`, [runId]);
      return result.rows[0] === undefined ? null : mapRun(result.rows[0]);
    } finally { client.release(); }
  }

  async savePage(input: {
    readonly runId: EntityId;
    readonly cursor: string;
    readonly nextCursor: string;
    readonly hasMore: boolean;
    readonly items: readonly { readonly targetExternalId: string; readonly sourceExternalId: string; readonly taxonomies: JsonObject }[];
  }): Promise<void> {
    await transaction(this.pool, async (client) => {
      const locked = await client.query<DatabaseRow>(
        "SELECT * FROM target_classification_sync_runs WHERE id = $1 FOR UPDATE",
        [input.runId],
      );
      const run = locked.rows[0];
      if (run === undefined) throw new IntegrationContractError(`Classification sync run does not exist: ${input.runId}`);
      if (run.status === "completed" || run.status === "failed") return;
      if (String(run.cursor) !== input.cursor) {
        if (BigInt(String(run.cursor)) >= BigInt(input.nextCursor)) return;
        throw new IntegrationContractError(`Classification sync cursor changed from ${input.cursor} to ${String(run.cursor)}`);
      }

      await client.query(
        `INSERT INTO target_classification_import_products (
           run_id, target_external_id, source_external_id, source_product_id, taxonomies
         )
         SELECT $1, item.target_external_id, item.source_external_id, product.id, item.taxonomies
         FROM JSONB_TO_RECORDSET($2::JSONB) AS item(
           target_external_id TEXT, source_external_id TEXT, taxonomies JSONB
         )
         JOIN target_classification_sync_runs run ON run.id = $1
         LEFT JOIN source_products product
           ON product.source_id = run.source_id AND product.external_id = item.source_external_id
         ON CONFLICT (run_id, target_external_id) DO UPDATE
         SET source_external_id = EXCLUDED.source_external_id,
             source_product_id = EXCLUDED.source_product_id,
             taxonomies = EXCLUDED.taxonomies`,
        [input.runId, JSON.stringify(input.items.map((item) => ({
          target_external_id: item.targetExternalId,
          source_external_id: item.sourceExternalId,
          taxonomies: item.taxonomies,
        })))],
      );
      await client.query(
        `UPDATE target_classification_sync_runs run
         SET status = 'running', started_at = COALESCE(started_at, NOW()), cursor = $2,
             fetched_product_count = stats.fetched,
             matched_source_product_count = stats.matched,
             assignment_count = stats.assignments,
             updated_at = NOW()
         FROM (
           SELECT COUNT(*)::BIGINT AS fetched,
                  COUNT(source_product_id)::BIGINT AS matched,
                  COALESCE(SUM((SELECT COUNT(*) FROM JSONB_EACH(product.taxonomies) taxonomy
                    CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(taxonomy.value))), 0)::BIGINT AS assignments
           FROM target_classification_import_products product
           WHERE product.run_id = $1
         ) stats
         WHERE run.id = $1`,
        [input.runId, input.nextCursor],
      );
      if (input.hasMore) {
        await client.query(
          `INSERT INTO jobs (job_type, payload, status, available_at, unique_key)
           VALUES ('sync_target_classifications', JSONB_BUILD_OBJECT('runId', $1::TEXT, 'cursor', $2::TEXT), 'pending', NOW(), $3)
           ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry') DO NOTHING`,
          [input.runId, input.nextCursor, `target-classification-sync:${input.runId}:${input.nextCursor}`],
        );
      } else {
        await buildSuggestions(client, input.runId);
      }
    });
  }

  async failRun(runId: EntityId, error: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE target_classification_sync_runs
         SET status = 'failed', last_error = $2, finished_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'running')`,
        [runId, error],
      );
    } finally { client.release(); }
  }

  async listSuggestions(query: TargetClassificationSuggestionQuery): Promise<TargetClassificationSuggestionResult> {
    const filterParameters: unknown[] = [];
    const where = ["suggestion.run_id = latest.id"];
    if (query.typeCode !== undefined) { filterParameters.push(query.typeCode); where.push(`suggestion.type_code = $${filterParameters.length + 1}`); }
    if (query.status !== undefined) { filterParameters.push(query.status); where.push(`suggestion.status = $${filterParameters.length + 1}`); }
    if (query.search !== undefined && query.search.trim() !== "") {
      filterParameters.push(`%${query.search.trim()}%`);
      where.push(`(suggestion.source_value ILIKE $${filterParameters.length + 1} OR suggestion.target_name ILIKE $${filterParameters.length + 1})`);
    }
    const limitParameter = filterParameters.length + 2;
    const offsetParameter = filterParameters.length + 3;
    const client = await this.pool.connect();
    try {
      const runs = await client.query<DatabaseRow>(
        `${runSelect}
         WHERE run.target_id = $1 AND run.source_id = $2
         ORDER BY run.created_at DESC, run.id DESC`,
        [query.targetId, query.sourceId],
      );
      const activeRun = runs.rows.find((row) => row.status !== "completed");
      const latestCompleted = runs.rows.find((row) => row.status === "completed");
      if (latestCompleted === undefined) {
        return { items: [], total: 0, summary: { readyCount: 0, readyProductCount: 0, conflictCount: 0, appliedCount: 0 },
          latestCompletedRun: null, activeRun: activeRun === undefined ? null : mapRun(activeRun) };
      }
      const result = await client.query<DatabaseRow>(
        `WITH latest AS (SELECT $1::BIGINT AS id), filtered AS MATERIALIZED (
           SELECT suggestion.* FROM target_classification_suggestions suggestion, latest
           WHERE ${where.join(" AND ")}
         ), summary AS (
           SELECT COUNT(*) FILTER (WHERE status = 'ready')::BIGINT AS ready_count,
                  COALESCE(SUM(matched_product_count) FILTER (WHERE status = 'ready'), 0)::BIGINT AS ready_product_count,
                  COUNT(*) FILTER (WHERE status = 'conflict')::BIGINT AS conflict_count,
                  COUNT(*) FILTER (WHERE status = 'applied')::BIGINT AS applied_count
           FROM target_classification_suggestions suggestion, latest
           WHERE suggestion.run_id = latest.id
         )
         SELECT filtered.*, COUNT(*) OVER() AS total,
                summary.ready_count, summary.ready_product_count,
                summary.conflict_count, summary.applied_count
         FROM filtered CROSS JOIN summary
         ORDER BY CASE filtered.status WHEN 'ready' THEN 0 WHEN 'conflict' THEN 1 ELSE 2 END,
                  filtered.matched_product_count DESC, filtered.id DESC
         LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        [latestCompleted.id, ...filterParameters, query.limit, query.offset],
      );
      const first = result.rows[0];
      const summary = first === undefined
        ? await client.query<DatabaseRow>(
          `SELECT COUNT(*) FILTER (WHERE status = 'ready')::BIGINT AS ready_count,
                  COALESCE(SUM(matched_product_count) FILTER (WHERE status = 'ready'), 0)::BIGINT AS ready_product_count,
                  COUNT(*) FILTER (WHERE status = 'conflict')::BIGINT AS conflict_count,
                  COUNT(*) FILTER (WHERE status = 'applied')::BIGINT AS applied_count
           FROM target_classification_suggestions WHERE run_id = $1`, [latestCompleted.id])
        : null;
      const summaryRow = first ?? summary!.rows[0]!;
      return {
        items: result.rows.map(mapSuggestion),
        total: Number(first?.total ?? 0),
        summary: {
          readyCount: Number(summaryRow.ready_count ?? 0),
          readyProductCount: Number(summaryRow.ready_product_count ?? 0),
          conflictCount: Number(summaryRow.conflict_count ?? 0),
          appliedCount: Number(summaryRow.applied_count ?? 0),
        },
        latestCompletedRun: mapRun(latestCompleted),
        activeRun: activeRun === undefined ? null : mapRun(activeRun),
      };
    } finally { client.release(); }
  }

  async getReadySuggestions(runId: EntityId, suggestionIds: readonly EntityId[]): Promise<readonly TargetClassificationSuggestion[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<DatabaseRow>(
        `SELECT * FROM target_classification_suggestions
         WHERE run_id = $1 AND id = ANY($2::BIGINT[]) AND status = 'ready'
         ORDER BY matched_product_count DESC, id`,
        [runId, suggestionIds],
      );
      return result.rows.map(mapSuggestion);
    } finally { client.release(); }
  }

  async listSuggestionExamples(suggestionId: EntityId, perTargetLimit: number): Promise<{
    readonly suggestion: TargetClassificationSuggestion;
    readonly items: readonly TargetClassificationSuggestionExample[];
  } | null> {
    const client = await this.pool.connect();
    try {
      const suggestionResult = await client.query<DatabaseRow>(
        "SELECT * FROM target_classification_suggestions WHERE id = $1",
        [suggestionId],
      );
      const suggestionRow = suggestionResult.rows[0];
      if (suggestionRow === undefined) return null;
      const examples = await client.query<DatabaseRow>(
        `WITH selected AS MATERIALIZED (
           SELECT suggestion.*,
                  CASE suggestion.type_code
                    WHEN 'brand' THEN 'pa_brand'
                    WHEN 'model' THEN 'pa_model'
                    WHEN 'category' THEN 'product_cat'
                  END AS taxonomy
           FROM target_classification_suggestions suggestion
           WHERE suggestion.id = $1
         ), matched_products AS MATERIALIZED (
           SELECT DISTINCT imported.id AS import_product_id,
                  imported.source_product_id, imported.source_external_id,
                  imported.target_external_id, imported.taxonomies,
                  COALESCE(NULLIF(internal.data->>'title', ''),
                           NULLIF(product.discovery_metadata->>'title', ''),
                           NULLIF(product.slug, ''), product.source_key) AS title,
                  product.url AS source_url, selected.taxonomy
           FROM selected
           JOIN target_classification_import_products imported ON imported.run_id = selected.run_id
           JOIN source_products product ON product.id = imported.source_product_id
           LEFT JOIN internal_products internal ON internal.source_product_id = product.id
           JOIN source_product_classification_links link
             ON link.source_product_id = product.id AND link.active = TRUE
           JOIN classification_candidates candidate ON candidate.id = link.candidate_id
           JOIN reference_types type ON type.id = candidate.reference_type_id
           WHERE type.code = selected.type_code
             AND ((selected.suggestion_kind = 'rule' AND candidate.context_key = selected.group_key)
               OR (selected.suggestion_kind = 'mapping' AND candidate.id::TEXT = selected.group_key))
         ), product_terms AS (
           SELECT product.*, term->>'term_id' AS term_external_value,
                  COALESCE(NULLIF(term->>'name', ''), term->>'term_id') AS term_name
           FROM matched_products product
           LEFT JOIN LATERAL JSONB_ARRAY_ELEMENTS(
             COALESCE(product.taxonomies->product.taxonomy, '[]'::JSONB)
           ) term ON TRUE
         ), ranked AS (
           SELECT product_terms.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY term_external_value
                    ORDER BY title, source_product_id, target_external_id
                  ) AS example_number
           FROM product_terms
         )
         SELECT source_product_id, source_external_id, target_external_id,
                title, source_url, term_external_value, term_name
         FROM ranked
         WHERE example_number <= $2
         ORDER BY term_external_value NULLS LAST, example_number`,
        [suggestionId, perTargetLimit],
      );
      return { suggestion: mapSuggestion(suggestionRow), items: examples.rows.map(mapExample) };
    } finally { client.release(); }
  }

  async getSuggestion(runId: EntityId, suggestionId: EntityId): Promise<TargetClassificationSuggestion | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<DatabaseRow>(
        "SELECT * FROM target_classification_suggestions WHERE run_id = $1 AND id = $2",
        [runId, suggestionId],
      );
      return result.rows[0] === undefined ? null : mapSuggestion(result.rows[0]);
    } finally { client.release(); }
  }

  async markApplied(input: {
    readonly suggestionId: EntityId;
    readonly dictionaryValueId: EntityId;
    readonly externalValue: string;
    readonly targetName: string;
    readonly resolutionKind: "mapping" | "rule";
    readonly resolutionId: EntityId;
    readonly actor: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE target_classification_suggestions
         SET status = 'applied', dictionary_value_id = $2, external_value = $3, target_name = $4,
             applied_resolution_kind = $5, applied_resolution_id = $6,
             applied_at = NOW(), applied_by = $7, updated_at = NOW()
         WHERE id = $1 AND status IN ('ready', 'conflict')`,
        [input.suggestionId, input.dictionaryValueId, input.externalValue, input.targetName,
          input.resolutionKind, input.resolutionId, input.actor],
      );
    } finally { client.release(); }
  }
}
