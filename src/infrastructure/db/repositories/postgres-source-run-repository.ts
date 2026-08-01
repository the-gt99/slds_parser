import type { EntityId } from "../../../contracts/index.js";
import type { CompleteSourceRunInput, CreateSourceRunInput, FailSourceRunInput, RecordSourceRunPageInput, SourceRunRecord, SourceRunRepository } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { requireRow } from "./repository-utils.js";
import { mapSourceRun, type DatabaseRow } from "./row-mappers.js";

export class PostgresSourceRunRepository implements SourceRunRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async findActiveBySource(sourceId: EntityId): Promise<SourceRunRecord | null> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM source_collection_runs WHERE source_id = $1 AND status = 'running'", [sourceId]);
    return result.rows[0] ? mapSourceRun(result.rows[0]) : null;
  }

  async create(input: CreateSourceRunInput): Promise<SourceRunRecord> {
    const result = await this.executor.query<DatabaseRow>(`INSERT INTO source_collection_runs (source_id, run_type, coverage, status, completeness, checkpoint) VALUES ($1, $2, $3, 'running', 'unknown', $4::jsonb) RETURNING *`, [input.sourceId, input.runType, input.coverage, input.checkpoint]);
    return mapSourceRun(requireRow(result.rows, "source run", input.sourceId));
  }

  async recordPage(id: EntityId, input: RecordSourceRunPageInput): Promise<SourceRunRecord> {
    const result = await this.executor.query<DatabaseRow>(`UPDATE source_collection_runs SET checkpoint = $2::jsonb, processed_count = processed_count + $3::bigint, discovered_count = discovered_count + $4::bigint, error_count = error_count + $5::bigint, completeness = $6 WHERE id = $1 RETURNING *`, [id, input.checkpoint, input.processedCount, input.discoveredCount, input.errorCount, input.completeness]);
    return mapSourceRun(requireRow(result.rows, "source run", id));
  }

  async complete(id: EntityId, input: CompleteSourceRunInput): Promise<SourceRunRecord> {
    const result = await this.executor.query<DatabaseRow>(`UPDATE source_collection_runs SET checkpoint = $2::jsonb, completeness = $3, status = 'completed', finished_at = $4, last_error = NULL WHERE id = $1 RETURNING *`, [id, input.checkpoint, input.completeness, input.finishedAt]);
    return mapSourceRun(requireRow(result.rows, "source run", id));
  }

  async fail(id: EntityId, input: FailSourceRunInput): Promise<SourceRunRecord> {
    const result = await this.executor.query<DatabaseRow>(`UPDATE source_collection_runs SET checkpoint = $2::jsonb, status = 'failed', finished_at = $3, last_error = $4 WHERE id = $1 RETURNING *`, [id, input.checkpoint, input.finishedAt, input.error]);
    return mapSourceRun(requireRow(result.rows, "source run", id));
  }
}
