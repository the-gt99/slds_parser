import type { JsonObject } from "../../../contracts/index.js";
import type {
  TargetDictionaryQuery,
  TargetDictionaryRepository,
  TargetDictionaryValueInput,
  TargetDictionaryValueRecord,
  TargetRecord,
  StartTargetTermCreationInput,
} from "../../../repositories/index.js";
import type { SqlClient, SqlPool } from "../sql-executor.js";
import { requireRow } from "./repository-utils.js";
import { mapTarget, type DatabaseRow } from "./row-mappers.js";

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp(value);
}

function mapDictionaryValue(row: DatabaseRow): TargetDictionaryValueRecord {
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    entityType: String(row.entity_type),
    externalId: String(row.external_id),
    name: String(row.name),
    slug: nullableText(row.slug),
    parentExternalId: nullableText(row.parent_external_id),
    taxonomy: nullableText(row.taxonomy),
    attributeCode: nullableText(row.attribute_code),
    remoteUpdatedAt: nullableTimestamp(row.remote_updated_at),
    syncCursor: nullableText(row.sync_cursor),
    metadata: row.metadata as JsonObject,
    active: Boolean(row.active),
    firstSeenAt: timestamp(row.first_seen_at),
    lastSeenAt: timestamp(row.last_seen_at),
  };
}

async function withClient<Result>(
  pool: SqlPool,
  callback: (client: SqlClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export class PostgresTargetDictionaryRepository implements TargetDictionaryRepository {
  constructor(private readonly pool: SqlPool) {}

  async listTargets(): Promise<readonly TargetRecord[]> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>("SELECT * FROM targets ORDER BY name, id");
      return result.rows.map(mapTarget);
    });
  }

  async listValues(query: TargetDictionaryQuery): Promise<readonly TargetDictionaryValueRecord[]> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `SELECT *
         FROM target_dictionary_values
         WHERE target_id = $1
           AND entity_type = $2
           AND active = TRUE
           AND ($3::TEXT = '' OR name ILIKE '%' || $3 || '%' OR COALESCE(slug, '') ILIKE '%' || $3 || '%')
         ORDER BY name, external_id
         LIMIT $4 OFFSET $5`,
        [query.targetId, query.entityType, query.search?.trim() ?? "", query.limit, query.offset],
      );
      return result.rows.map(mapDictionaryValue);
    });
  }

  async replaceEntityValues(
    targetId: string,
    entityType: string,
    values: readonly TargetDictionaryValueInput[],
  ): Promise<number> {
    return withClient(this.pool, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(
          `UPDATE target_dictionary_values
           SET active = FALSE, updated_at = NOW()
           WHERE target_id = $1 AND entity_type = $2 AND active = TRUE`,
          [targetId, entityType],
        );

        if (values.length > 0) {
          await this.upsertMany(client, targetId, entityType, values);
        }
        await client.query("COMMIT");
        return values.length;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async upsertValue(
    targetId: string,
    entityType: string,
    value: TargetDictionaryValueInput,
  ): Promise<TargetDictionaryValueRecord> {
    return withClient(this.pool, async (client) => {
      const result = await this.upsertMany(client, targetId, entityType, [value]);
      return mapDictionaryValue(requireRow(result.rows, "target dictionary value", value.externalId));
    });
  }

  async startTermCreation(input: StartTargetTermCreationInput): Promise<string> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `INSERT INTO target_term_creation_history (
           target_id, source_id, observation_id, entity_type, requested_name,
           requested_slug, requested_parent_external_id, status, actor
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8)
         RETURNING id`,
        [
          input.targetId,
          input.sourceId,
          input.observationId,
          input.entityType,
          input.name,
          input.slug ?? null,
          input.parentExternalId ?? null,
          input.actor,
        ],
      );
      return String(requireRow(result.rows, "target term creation", input.name).id);
    });
  }

  async completeTermCreation(id: string, externalId: string): Promise<void> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `UPDATE target_term_creation_history
         SET status = 'completed', external_id = $2, error = NULL,
             finished_at = NOW()
         WHERE id = $1 AND status = 'running'
         RETURNING id`,
        [id, externalId],
      );
      requireRow(result.rows, "target term creation", id);
    });
  }

  async failTermCreation(id: string, error: string, externalId?: string): Promise<void> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<DatabaseRow>(
        `UPDATE target_term_creation_history
         SET status = 'failed', external_id = $3, error = $2,
             finished_at = NOW()
         WHERE id = $1 AND status = 'running'
         RETURNING id`,
        [id, error, externalId ?? null],
      );
      requireRow(result.rows, "target term creation", id);
    });
  }

  private upsertMany(
    client: SqlClient,
    targetId: string,
    entityType: string,
    values: readonly TargetDictionaryValueInput[],
  ) {
    return client.query<DatabaseRow>(
      `WITH incoming AS (
        SELECT *
        FROM JSONB_TO_RECORDSET($3::JSONB) AS item(
          external_id TEXT,
          name TEXT,
          slug TEXT,
          parent_external_id TEXT,
          taxonomy TEXT,
          attribute_code TEXT,
          remote_updated_at TIMESTAMPTZ,
          sync_cursor TEXT,
          metadata JSONB
        )
      )
      INSERT INTO target_dictionary_values (
        target_id, entity_type, external_id, name, slug, parent_external_id,
        taxonomy, attribute_code, remote_updated_at, sync_cursor, metadata,
        active, last_seen_at
      )
      SELECT
        $1, $2, external_id, name, slug, parent_external_id,
        taxonomy, attribute_code, remote_updated_at, sync_cursor, metadata,
        TRUE, NOW()
      FROM incoming
      ON CONFLICT (target_id, entity_type, external_id) DO UPDATE SET
        name = EXCLUDED.name,
        slug = EXCLUDED.slug,
        parent_external_id = EXCLUDED.parent_external_id,
        taxonomy = EXCLUDED.taxonomy,
        attribute_code = EXCLUDED.attribute_code,
        remote_updated_at = EXCLUDED.remote_updated_at,
        sync_cursor = EXCLUDED.sync_cursor,
        metadata = EXCLUDED.metadata,
        active = TRUE,
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING *`,
      [targetId, entityType, JSON.stringify(values.map((value) => ({
        external_id: value.externalId,
        name: value.name,
        slug: value.slug ?? null,
        parent_external_id: value.parentExternalId ?? null,
        taxonomy: value.taxonomy ?? null,
        attribute_code: value.attributeCode ?? null,
        remote_updated_at: value.remoteUpdatedAt ?? null,
        sync_cursor: value.syncCursor ?? null,
        metadata: value.metadata,
      })))],
    );
  }
}
