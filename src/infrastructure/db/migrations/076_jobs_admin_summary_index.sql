CREATE INDEX IF NOT EXISTS jobs_admin_type_status_idx
  ON jobs (job_type, status);
