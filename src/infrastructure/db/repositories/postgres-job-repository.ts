import type { EntityId } from "../../../contracts/index.js";
import type { EnqueueJobInput, JobRecord, JobRepository, RetryJobInput } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { requireRow } from "./repository-utils.js";
import { mapJob, type DatabaseRow } from "./row-mappers.js";

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const result = await this.executor.query<DatabaseRow>(`INSERT INTO jobs (job_type, payload, status, available_at, unique_key) VALUES ($1, $2::jsonb, 'pending', COALESCE($3::timestamptz, NOW()), $4) ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry') DO UPDATE SET unique_key = jobs.unique_key RETURNING *`, [input.jobType, input.payload, input.availableAt ?? null, input.uniqueKey]);
    return mapJob(requireRow(result.rows, "job", `${input.jobType}/${input.uniqueKey}`));
  }

  async claimNext(workerId: string, lockTimeoutMs: number): Promise<JobRecord | null> {
    const result = await this.executor.query<DatabaseRow>(`WITH candidate AS (SELECT id FROM jobs WHERE ((status IN ('pending', 'retry') AND available_at <= NOW()) OR (status = 'running' AND locked_at < NOW() - ($2::double precision * INTERVAL '1 millisecond'))) ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs SET status = 'running', locked_at = NOW(), locked_by = $1, attempts = attempts + 1, finished_at = NULL, updated_at = NOW() FROM candidate WHERE jobs.id = candidate.id RETURNING jobs.*`, [workerId, lockTimeoutMs]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async complete(id: EntityId): Promise<void> {
    const result = await this.executor.query<DatabaseRow>(`UPDATE jobs SET status = 'completed', finished_at = NOW(), locked_at = NULL, locked_by = NULL, updated_at = NOW() WHERE id = $1 RETURNING id`, [id]);
    requireRow(result.rows, "job", id);
  }

  async retry(id: EntityId, input: RetryJobInput): Promise<void> {
    const result = await this.executor.query<DatabaseRow>(`UPDATE jobs SET status = 'retry', available_at = $2, last_error = $3, locked_at = NULL, locked_by = NULL, finished_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING id`, [id, input.availableAt, input.error]);
    requireRow(result.rows, "job", id);
  }

  async fail(id: EntityId, error: string): Promise<void> {
    const result = await this.executor.query<DatabaseRow>(`UPDATE jobs SET status = 'failed', finished_at = NOW(), last_error = $2, locked_at = NULL, locked_by = NULL, updated_at = NOW() WHERE id = $1 RETURNING id`, [id, error]);
    requireRow(result.rows, "job", id);
  }
}
