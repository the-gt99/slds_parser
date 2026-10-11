CREATE STATISTICS jobs_type_status_statistics (mcv)
  ON job_type, status FROM jobs;

ANALYZE jobs (job_type, status);
