CREATE INDEX IF NOT EXISTS jobs_admin_created_idx
  ON jobs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS jobs_admin_status_created_idx
  ON jobs (status, created_at DESC, id DESC)
  INCLUDE (job_type);

CREATE INDEX IF NOT EXISTS jobs_admin_type_created_idx
  ON jobs (job_type, created_at DESC, id DESC)
  INCLUDE (status);

CREATE INDEX IF NOT EXISTS jobs_source_product_search_idx
  ON jobs ((payload->>'sourceProductId'));

CREATE INDEX IF NOT EXISTS jobs_internal_product_search_idx
  ON jobs ((payload->>'internalProductId'));

CREATE INDEX IF NOT EXISTS jobs_completed_finished_idx
  ON jobs (finished_at DESC)
  WHERE status = 'completed';
