import type { EntityId } from "../../../contracts/index.js";
import type { InternalProductRecord, InternalProductRepository, UpsertInternalProductInput } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { requireRow } from "./repository-utils.js";
import { mapInternalProduct, type DatabaseRow } from "./row-mappers.js";

export class PostgresInternalProductRepository implements InternalProductRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async findBySourceProductId(sourceProductId: EntityId): Promise<InternalProductRecord | null> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM internal_products WHERE source_product_id = $1", [sourceProductId]);
    return result.rows[0] ? mapInternalProduct(result.rows[0]) : null;
  }

  async upsert(input: UpsertInternalProductInput): Promise<InternalProductRecord> {
    const result = await this.executor.query<DatabaseRow>(`INSERT INTO internal_products (source_product_id, data, input_hash, content_hash, processor_version, status, processed_at, last_error) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8) ON CONFLICT (source_product_id) DO UPDATE SET data = EXCLUDED.data, input_hash = EXCLUDED.input_hash, content_hash = EXCLUDED.content_hash, processor_version = EXCLUDED.processor_version, status = EXCLUDED.status, processed_at = EXCLUDED.processed_at, last_error = EXCLUDED.last_error, updated_at = NOW() RETURNING *`, [input.sourceProductId, input.data, input.inputHash, input.contentHash, input.processorVersion, input.status, input.processedAt ?? null, input.lastError ?? null]);
    return mapInternalProduct(requireRow(result.rows, "internal product", input.sourceProductId));
  }
}
