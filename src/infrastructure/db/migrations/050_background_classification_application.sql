ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (
  job_type IN (
    'discover_source',
    'collect_product',
    'process_product',
    'sync_target_classifications',
    'apply_target_classification_suggestion',
    'preflight_product',
    'export_product'
  )
);

ALTER TABLE target_classification_suggestions
  DROP CONSTRAINT IF EXISTS target_classification_suggestions_status_check;

ALTER TABLE target_classification_suggestions
  ADD CONSTRAINT target_classification_suggestions_status_check
  CHECK (status IN ('ready', 'queued', 'conflict', 'applied'));

ALTER TABLE target_classification_suggestions
  ADD COLUMN queued_at TIMESTAMPTZ,
  ADD COLUMN queued_by TEXT,
  ADD COLUMN last_apply_error TEXT;

CREATE INDEX jobs_target_classification_apply_active_idx
  ON jobs (job_type, unique_key)
  WHERE job_type = 'apply_target_classification_suggestion'
    AND status IN ('pending', 'running', 'retry');
