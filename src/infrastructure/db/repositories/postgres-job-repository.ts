import type { EntityId } from "../../../contracts/index.js";
import type { EnqueueJobInput, JobRecord, JobRepository, JobType, RetryJobInput } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { requireRow } from "./repository-utils.js";
import { mapJob, type DatabaseRow } from "./row-mappers.js";

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const jobs = await this.enqueueMany([input]);
    return requireRow(jobs, "job", `${input.jobType}/${input.uniqueKey}`);
  }

  async enqueueMany(inputs: readonly EnqueueJobInput[]): Promise<readonly JobRecord[]> {
    const jobs: JobRecord[] = [];
    const batchSize = 1_000;
    for (let offset = 0; offset < inputs.length; offset += batchSize) {
      const batch = inputs.slice(offset, offset + batchSize);
      const values: unknown[] = [];
      const rows = batch.map((input) => {
        const start = values.length;
        values.push(input.jobType, input.payload, input.availableAt ?? null, input.uniqueKey);
        return `($${start + 1}, $${start + 2}::jsonb, 'pending', COALESCE($${start + 3}::timestamptz, NOW()), $${start + 4})`;
      });
      const result = await this.executor.query<DatabaseRow>(
        `INSERT INTO jobs (job_type, payload, status, available_at, unique_key)
         VALUES ${rows.join(", ")}
         ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry')
         DO UPDATE SET unique_key = jobs.unique_key
         RETURNING *`,
        values,
      );
      jobs.push(...result.rows.map(mapJob));
    }
    return jobs;
  }

  async claimNext(workerId: string, lockTimeoutMs: number, jobTypes?: readonly JobType[]): Promise<JobRecord | null> {
    const singleJobType = jobTypes?.length === 1 ? jobTypes[0]! : undefined;
    const jobTypeParameter = singleJobType ?? jobTypes ?? null;
    const expiredJobTypeFilter = singleJobType === undefined
      ? "($3::TEXT[] IS NULL OR job_type = ANY($3::TEXT[]))"
      : "job_type = $3::TEXT";
    const expired = await this.executor.query<DatabaseRow>(
      `WITH candidate AS (
         SELECT id
         FROM jobs
         WHERE ${expiredJobTypeFilter}
           AND status = 'running'
           AND locked_at < NOW() - ($2::DOUBLE PRECISION * INTERVAL '1 millisecond')
           AND (jobs.job_type <> 'reclassify_product' OR NOT EXISTS (
             SELECT 1 FROM jobs application_job
             WHERE application_job.job_type = 'apply_target_classification_suggestion'
               AND application_job.status IN ('pending', 'running', 'retry')
           ))
         ORDER BY locked_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs
       SET status = 'running', started_at = NOW(), locked_at = NOW(), locked_by = $1,
           attempts = attempts + 1, finished_at = NULL, updated_at = NOW()
       FROM candidate
       WHERE jobs.id = candidate.id
       RETURNING jobs.*`,
      [workerId, lockTimeoutMs, jobTypeParameter],
    );
    if (expired.rows[0]) return mapJob(expired.rows[0]);

    const availableJobTypeFilter = singleJobType === undefined
      ? "($2::TEXT[] IS NULL OR job_type = ANY($2::TEXT[]))"
      : "job_type = $2::TEXT";
    const available = await this.executor.query<DatabaseRow>(
      `WITH candidate AS (
         SELECT id
         FROM jobs
         WHERE ${availableJobTypeFilter}
           AND status IN ('pending', 'retry')
           AND available_at <= NOW()
           AND (jobs.job_type <> 'reclassify_product' OR NOT EXISTS (
             SELECT 1 FROM jobs application_job
             WHERE application_job.job_type = 'apply_target_classification_suggestion'
               AND application_job.status IN ('pending', 'running', 'retry')
           ))
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs
       SET status = 'running', started_at = NOW(), locked_at = NOW(), locked_by = $1,
           attempts = attempts + 1, finished_at = NULL, updated_at = NOW()
       FROM candidate
       WHERE jobs.id = candidate.id
       RETURNING jobs.*`,
      [workerId, jobTypeParameter],
    );
    return available.rows[0] ? mapJob(available.rows[0]) : null;
  }

  async claimById(id: EntityId, workerId: string, jobTypes: readonly JobType[]): Promise<JobRecord | null> {
    const result = await this.executor.query<DatabaseRow>(
      `UPDATE jobs
          SET status = 'running', started_at = NOW(), locked_at = NOW(), locked_by = $2,
              attempts = attempts + 1, finished_at = NULL, updated_at = NOW()
        WHERE id = $1
          AND job_type = ANY($3::TEXT[])
          AND status IN ('pending', 'retry')
      RETURNING *`,
      [id, workerId, jobTypes],
    );
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
