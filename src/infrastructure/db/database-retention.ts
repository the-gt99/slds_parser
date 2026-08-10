import type { SqlClient, SqlPool } from "./sql-executor.js";

export interface DatabaseRetentionOptions {
  readonly completedJobsBefore: Date;
  readonly failedJobsBefore: Date;
  readonly processingHistoryBefore: Date;
  readonly inactiveObservationsBefore: Date;
  readonly batchSize: number;
}

export interface DatabaseRetentionResult {
  readonly completedJobs: number;
  readonly failedJobs: number;
  readonly processingAttempts: number;
  readonly operationExecutions: number;
  readonly inactiveObservations: number;
  readonly orphanedClassificationEvidence: number;
  readonly orphanedClassificationCandidates: number;
}

interface HistoryCleanupRow extends Record<string, unknown> {
  readonly attempts: number;
  readonly operations: number;
}

async function deleteInBatches(
  client: SqlClient,
  sql: string,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  let total = 0;
  while (true) {
    const result = await client.query(sql, [cutoff.toISOString(), batchSize]);
    const deleted = result.rowCount ?? result.rows.length;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

async function deleteOrphansInBatches(
  client: SqlClient,
  sql: string,
  batchSize: number,
): Promise<number> {
  let total = 0;
  while (true) {
    const result = await client.query(sql, [batchSize]);
    const deleted = result.rowCount ?? result.rows.length;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

export class DatabaseRetentionService {
  constructor(private readonly pool: SqlPool) {}

  async cleanup(options: DatabaseRetentionOptions): Promise<DatabaseRetentionResult> {
    const client = await this.pool.connect();
    try {
      const completedJobs = await deleteInBatches(
        client,
         `WITH expired AS MATERIALIZED (
           SELECT id FROM jobs
           WHERE status = 'completed' AND finished_at < $1::TIMESTAMPTZ
           ORDER BY finished_at, id
           LIMIT $2
         )
         DELETE FROM jobs USING expired
         WHERE jobs.id = expired.id
         RETURNING jobs.id`,
        options.completedJobsBefore,
        options.batchSize,
      );
      const failedJobs = await deleteInBatches(
        client,
        `WITH expired AS MATERIALIZED (
           SELECT id FROM jobs
           WHERE status = 'failed' AND COALESCE(finished_at, updated_at) < $1::TIMESTAMPTZ
           ORDER BY COALESCE(finished_at, updated_at), id
           LIMIT $2
         )
         DELETE FROM jobs USING expired
         WHERE jobs.id = expired.id
         RETURNING jobs.id`,
        options.failedJobsBefore,
        options.batchSize,
      );

      let processingAttempts = 0;
      let operationExecutions = 0;
      while (true) {
        const history = await client.query<HistoryCleanupRow>(
          `WITH expired AS MATERIALIZED (
             SELECT attempt_id
             FROM product_processing_attempts
             WHERE status IN ('completed', 'failed') AND finished_at < $1::TIMESTAMPTZ
             ORDER BY finished_at, attempt_id
             LIMIT $2
           ), deleted_operations AS (
             DELETE FROM product_operation_executions operation
             USING expired
             WHERE operation.attempt_id = expired.attempt_id
             RETURNING operation.id
           ), deleted_attempts AS (
             DELETE FROM product_processing_attempts attempt
             USING expired
             WHERE attempt.attempt_id = expired.attempt_id
             RETURNING attempt.attempt_id
           )
           SELECT
             (SELECT COUNT(*)::INTEGER FROM deleted_attempts) AS attempts,
             (SELECT COUNT(*)::INTEGER FROM deleted_operations) AS operations`,
          [options.processingHistoryBefore.toISOString(), options.batchSize],
        );
        const deletedAttempts = Number(history.rows[0]?.attempts ?? 0);
        processingAttempts += deletedAttempts;
        operationExecutions += Number(history.rows[0]?.operations ?? 0);
        if (deletedAttempts < options.batchSize) break;
      }

      const inactiveObservations = await deleteInBatches(
        client,
        `WITH expired AS MATERIALIZED (
           SELECT id FROM source_product_classification_links
           WHERE active = FALSE AND updated_at < $1::TIMESTAMPTZ
           ORDER BY updated_at, id
           LIMIT $2
         )
         DELETE FROM source_product_classification_links observation USING expired
         WHERE observation.id = expired.id
         RETURNING observation.id`,
        options.inactiveObservationsBefore,
        options.batchSize,
      );

      const orphanedClassificationEvidence = await deleteOrphansInBatches(
        client,
        `WITH orphaned AS MATERIALIZED (
           SELECT evidence.id
           FROM source_product_classification_evidence evidence
           WHERE NOT EXISTS (
             SELECT 1
             FROM source_product_classification_links observation
             WHERE observation.evidence_id = evidence.id
           )
           ORDER BY evidence.id
           LIMIT $1
         )
         DELETE FROM source_product_classification_evidence evidence USING orphaned
         WHERE evidence.id = orphaned.id
         RETURNING evidence.id`,
        options.batchSize,
      );
      const orphanedClassificationCandidates = await deleteOrphansInBatches(
        client,
        `WITH orphaned AS MATERIALIZED (
           SELECT candidate.id
           FROM classification_candidates candidate
           WHERE NOT EXISTS (
             SELECT 1
             FROM source_product_classification_links observation
             WHERE observation.candidate_id = candidate.id
           )
           ORDER BY candidate.id
           LIMIT $1
         )
         DELETE FROM classification_candidates candidate USING orphaned
         WHERE candidate.id = orphaned.id
         RETURNING candidate.id`,
        options.batchSize,
      );

      return {
        completedJobs,
        failedJobs,
        processingAttempts,
        operationExecutions,
        inactiveObservations,
        orphanedClassificationEvidence,
        orphanedClassificationCandidates,
      };
    } finally {
      client.release();
    }
  }
}
