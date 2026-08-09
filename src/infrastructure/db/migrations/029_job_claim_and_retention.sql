CREATE INDEX IF NOT EXISTS jobs_claim_available_idx
  ON jobs (job_type, available_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS jobs_claim_running_idx
  ON jobs (job_type, locked_at, id)
  WHERE status = 'running';

DROP INDEX IF EXISTS jobs_available_idx;
DROP INDEX IF EXISTS jobs_running_lock_idx;

ALTER TABLE jobs SET (
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.01
);

CREATE INDEX IF NOT EXISTS product_processing_attempts_retention_idx
  ON product_processing_attempts (finished_at, attempt_id)
  WHERE status IN ('completed', 'failed');

CREATE INDEX IF NOT EXISTS source_reference_observations_inactive_retention_idx
  ON source_reference_observations (updated_at, id)
  WHERE active = FALSE;

ALTER TABLE product_processing_attempts SET (
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE product_operation_executions SET (
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02
);
