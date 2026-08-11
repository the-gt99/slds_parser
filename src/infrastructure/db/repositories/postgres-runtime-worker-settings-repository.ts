import type {
  RuntimeWorkerSettingsRecord,
  RuntimeWorkerSettingsRepository,
  WorkerConcurrencySettings,
} from "../../../repositories/index.js";
import type { SqlClient, SqlPool } from "../sql-executor.js";
import type { DatabaseRow } from "./row-mappers.js";

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapSettings(row: DatabaseRow): RuntimeWorkerSettingsRecord {
  const appliedRevision = row.applied_revision;
  return {
    collectionConcurrency: Number(row.collection_concurrency),
    processConcurrency: Number(row.process_concurrency),
    preflightConcurrency: Number(row.preflight_concurrency),
    revision: String(row.revision),
    updatedBy: String(row.updated_by),
    updatedAt: timestamp(row.updated_at),
    applied: appliedRevision === null || appliedRevision === undefined ? null : {
      collectionConcurrency: Number(row.applied_collection_concurrency),
      processConcurrency: Number(row.applied_process_concurrency),
      preflightConcurrency: Number(row.applied_preflight_concurrency),
      revision: String(appliedRevision),
      workerId: String(row.applied_worker_id),
      appliedAt: timestamp(row.applied_at),
    },
  };
}

function jsonSettings(settings: WorkerConcurrencySettings): string {
  return JSON.stringify({
    collectionConcurrency: settings.collectionConcurrency,
    processConcurrency: settings.processConcurrency,
    preflightConcurrency: settings.preflightConcurrency,
  });
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

async function ensureRow(client: SqlClient, defaults: WorkerConcurrencySettings): Promise<void> {
  await client.query(
    `INSERT INTO runtime_worker_settings (
       singleton, collection_concurrency, process_concurrency, preflight_concurrency, updated_by
     ) VALUES (TRUE, $1, $2, $3, 'environment')
     ON CONFLICT (singleton) DO NOTHING`,
    [defaults.collectionConcurrency, defaults.processConcurrency, defaults.preflightConcurrency],
  );
}

async function lockedRow(client: SqlClient): Promise<DatabaseRow> {
  const result = await client.query<DatabaseRow>(
    "SELECT * FROM runtime_worker_settings WHERE singleton = TRUE FOR UPDATE",
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Runtime worker settings were not initialized");
  return row;
}

export class PostgresRuntimeWorkerSettingsRepository implements RuntimeWorkerSettingsRepository {
  constructor(private readonly pool: SqlPool) {}

  async getOrCreate(defaults: WorkerConcurrencySettings): Promise<RuntimeWorkerSettingsRecord> {
    return transaction(this.pool, async (client) => {
      await ensureRow(client, defaults);
      return mapSettings(await lockedRow(client));
    });
  }

  async save(settings: WorkerConcurrencySettings, actor: string): Promise<RuntimeWorkerSettingsRecord> {
    return transaction(this.pool, async (client) => {
      const currentRow = await lockedRow(client);
      const current = mapSettings(currentRow);
      if (current.collectionConcurrency === settings.collectionConcurrency
        && current.processConcurrency === settings.processConcurrency
        && current.preflightConcurrency === settings.preflightConcurrency) {
        return current;
      }

      const nextRevision = String(BigInt(current.revision) + 1n);
      const result = await client.query<DatabaseRow>(
        `UPDATE runtime_worker_settings
         SET collection_concurrency = $1,
             process_concurrency = $2,
             preflight_concurrency = $3,
             revision = $4,
             updated_by = $5,
             updated_at = NOW()
         WHERE singleton = TRUE
         RETURNING *`,
        [settings.collectionConcurrency, settings.processConcurrency, settings.preflightConcurrency, nextRevision, actor],
      );
      const updated = result.rows[0];
      if (updated === undefined) throw new Error("Runtime worker settings were not updated");
      await client.query(
        `INSERT INTO runtime_worker_settings_audit (
           revision, previous_settings, settings, actor
         ) VALUES ($1, $2::JSONB, $3::JSONB, $4)`,
        [nextRevision, jsonSettings(current), jsonSettings(settings), actor],
      );
      return mapSettings(updated);
    });
  }

  async loadAndMarkApplied(defaults: WorkerConcurrencySettings, workerId: string): Promise<RuntimeWorkerSettingsRecord> {
    return transaction(this.pool, async (client) => {
      await ensureRow(client, defaults);
      await lockedRow(client);
      const result = await client.query<DatabaseRow>(
        `UPDATE runtime_worker_settings
         SET applied_revision = revision,
             applied_collection_concurrency = collection_concurrency,
             applied_process_concurrency = process_concurrency,
             applied_preflight_concurrency = preflight_concurrency,
             applied_worker_id = $1,
             applied_at = NOW()
         WHERE singleton = TRUE
         RETURNING *`,
        [workerId],
      );
      const applied = result.rows[0];
      if (applied === undefined) throw new Error("Runtime worker settings were not marked as applied");
      return mapSettings(applied);
    });
  }
}
