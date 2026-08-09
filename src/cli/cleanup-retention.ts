import { createPostgresPool, DatabaseRetentionService } from "../infrastructure/db/index.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function cutoff(now: Date, ageMs: number): Date {
  return new Date(now.getTime() - ageMs);
}

const now = new Date();
const pool = createPostgresPool();

try {
  const result = await new DatabaseRetentionService(pool).cleanup({
    completedJobsBefore: cutoff(now, positiveInteger("PARSER_COMPLETED_JOB_RETENTION_HOURS", 24) * HOUR_MS),
    failedJobsBefore: cutoff(now, positiveInteger("PARSER_FAILED_JOB_RETENTION_DAYS", 30) * DAY_MS),
    processingHistoryBefore: cutoff(now, positiveInteger("PARSER_PROCESSING_HISTORY_RETENTION_DAYS", 30) * DAY_MS),
    inactiveObservationsBefore: cutoff(now, positiveInteger("PARSER_INACTIVE_OBSERVATION_RETENTION_DAYS", 30) * DAY_MS),
    batchSize: positiveInteger("PARSER_RETENTION_BATCH_SIZE", 10_000),
  });
  console.info(`Retention cleanup completed: ${JSON.stringify(result)}`);
} finally {
  await pool.end();
}
