ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (
  job_type IN (
    'discover_source',
    'collect_product',
    'process_product',
    'reclassify_product',
    'sync_target_classifications',
    'apply_target_classification_suggestion',
    'preflight_product',
    'export_product'
  )
);
