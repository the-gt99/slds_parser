import type { EntityId } from "../../../contracts/index.js";
import type { SourceRepository, SourceRecord, UpsertSourceDefinitionInput } from "../../../repositories/index.js";
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

  async upsertDefinition(input: UpsertSourceDefinitionInput): Promise<SourceRecord> {
    const result = await this.executor.query<DatabaseRow>(`INSERT INTO sources (code, name, adapter_code, config, enabled)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, adapter_code = EXCLUDED.adapter_code,
        config = EXCLUDED.config, enabled = EXCLUDED.enabled, updated_at = NOW()
      RETURNING ${COLUMNS}`, [input.code, input.name, input.adapterCode, input.config, input.enabled]);
    const row = result.rows[0];
    if (!row) throw new Error(`Source upsert returned no row: ${input.code}`);
    return mapSource(row);
  }
}
