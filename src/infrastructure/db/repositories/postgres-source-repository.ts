import type { EntityId } from "../../../contracts/index.js";
import type { SourceRepository, SourceRecord } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { mapSource, type DatabaseRow } from "./row-mappers.js";

const COLUMNS = "id, code, name, adapter_code, config, enabled, created_at, updated_at";

export class PostgresSourceRepository implements SourceRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async getById(id: EntityId): Promise<SourceRecord | null> {
    const result = await this.executor.query<DatabaseRow>(`SELECT ${COLUMNS} FROM sources WHERE id = $1`, [id]);
    return result.rows[0] ? mapSource(result.rows[0]) : null;
  }

  async listEnabled(): Promise<readonly SourceRecord[]> {
    const result = await this.executor.query<DatabaseRow>(`SELECT ${COLUMNS} FROM sources WHERE enabled = TRUE ORDER BY id`);
    return result.rows.map(mapSource);
  }
}
