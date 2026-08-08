ALTER TABLE jobs
  ADD COLUMN started_at TIMESTAMPTZ;

UPDATE jobs
SET started_at = locked_at
WHERE status = 'running'
  AND locked_at IS NOT NULL;

UPDATE jobs AS job
SET started_at = (
  SELECT attempt.started_at
  FROM product_processing_attempts AS attempt
  WHERE attempt.source_product_id = NULLIF(job.payload->>'sourceProductId', '')::BIGINT
    AND attempt.started_at >= job.created_at
    AND (job.finished_at IS NULL OR attempt.started_at <= job.finished_at)
  ORDER BY attempt.started_at DESC
  LIMIT 1
)
WHERE job.job_type = 'process_product'
  AND job.started_at IS NULL
  AND job.created_at >= NOW() - INTERVAL '7 days'
  AND NULLIF(job.payload->>'sourceProductId', '') IS NOT NULL;
