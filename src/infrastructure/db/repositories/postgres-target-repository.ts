import type { EntityId } from "../../../contracts/index.js";
import type {
  SaveExportFailureInput,
  SaveExportSuccessInput,
  SaveTargetProductSnapshotInput,
  TargetProductRecord,
  TargetProductSnapshotRecord,
  TargetRecord,
  TargetRepository,
} from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { requireRow } from "./repository-utils.js";
import { mapTarget, mapTargetProduct, mapTargetProductSnapshot, type DatabaseRow } from "./row-mappers.js";

export class PostgresTargetRepository implements TargetRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async getById(id: EntityId): Promise<TargetRecord | null> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM targets WHERE id = $1", [id]);
    return result.rows[0] ? mapTarget(result.rows[0]) : null;
  }

  async listEnabled(): Promise<readonly TargetRecord[]> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM targets WHERE enabled = TRUE ORDER BY id");
    return result.rows.map(mapTarget);
  }

  async findTargetProduct(targetId: EntityId, internalProductId: EntityId): Promise<TargetProductRecord | null> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM target_products WHERE target_id = $1 AND internal_product_id = $2", [targetId, internalProductId]);
    return result.rows[0] ? mapTargetProduct(result.rows[0]) : null;
  }

  async findProductSnapshot(targetId: EntityId, sourceProductId: EntityId): Promise<TargetProductSnapshotRecord | null> {
    const result = await this.executor.query<DatabaseRow>(
      "SELECT * FROM target_product_snapshots WHERE target_id = $1 AND source_product_id = $2",
      [targetId, sourceProductId],
    );
    return result.rows[0] ? mapTargetProductSnapshot(result.rows[0]) : null;
  }

  async saveProductSnapshot(input: SaveTargetProductSnapshotInput): Promise<TargetProductSnapshotRecord> {
    const result = await this.executor.query<DatabaseRow>(
      `WITH snapshot AS (
         INSERT INTO target_product_snapshots (
           target_id, source_product_id, external_id, source_external_id,
           payload, content_hash, fetched_at
         ) VALUES ($1, $2, $3, $4, $5::JSONB, $6, $7)
         ON CONFLICT (target_id, source_product_id) DO UPDATE SET
           external_id = EXCLUDED.external_id,
           source_external_id = EXCLUDED.source_external_id,
           payload = EXCLUDED.payload,
           content_hash = EXCLUDED.content_hash,
           fetched_at = EXCLUDED.fetched_at,
           updated_at = NOW()
         RETURNING *
       ), linked AS (
         INSERT INTO target_products (target_id, internal_product_id, external_id, status)
         SELECT $1, internal.id, $3, 'observed'
         FROM internal_products internal WHERE internal.source_product_id = $2
         ON CONFLICT (target_id, internal_product_id) DO UPDATE SET
           external_id = EXCLUDED.external_id,
           updated_at = NOW()
         RETURNING id
       )
       SELECT * FROM snapshot`,
      [input.targetId, input.sourceProductId, input.externalId, input.sourceExternalId, JSON.stringify(input.payload), input.contentHash, input.fetchedAt],
    );
    return mapTargetProductSnapshot(requireRow(result.rows, "target product snapshot", `${input.targetId}/${input.sourceProductId}`));
  }

  async saveExportSuccess(input: SaveExportSuccessInput): Promise<TargetProductRecord> {
    const result = await this.executor.query<DatabaseRow>(`INSERT INTO target_products (target_id, internal_product_id, external_id, status, last_exported_hash, last_export_fingerprint, last_attempt_at, synced_at, last_error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL) ON CONFLICT (target_id, internal_product_id) DO UPDATE SET external_id = EXCLUDED.external_id, status = EXCLUDED.status, last_exported_hash = EXCLUDED.last_exported_hash, last_export_fingerprint = EXCLUDED.last_export_fingerprint, last_attempt_at = EXCLUDED.last_attempt_at, synced_at = EXCLUDED.synced_at, last_error = NULL, updated_at = NOW() RETURNING *`, [input.targetId, input.internalProductId, input.externalId, input.status, input.exportedHash, input.exportFingerprint, input.attemptedAt, input.syncedAt]);
    return mapTargetProduct(requireRow(result.rows, "target product", `${input.targetId}/${input.internalProductId}`));
  }

  async saveExportFailure(input: SaveExportFailureInput): Promise<TargetProductRecord> {
    const result = await this.executor.query<DatabaseRow>(`INSERT INTO target_products (target_id, internal_product_id, status, last_attempt_at, last_error) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (target_id, internal_product_id) DO UPDATE SET status = EXCLUDED.status, last_attempt_at = EXCLUDED.last_attempt_at, last_error = EXCLUDED.last_error, updated_at = NOW() RETURNING *`, [input.targetId, input.internalProductId, input.status, input.attemptedAt, input.error]);
    return mapTargetProduct(requireRow(result.rows, "target product", `${input.targetId}/${input.internalProductId}`));
  }
}
