ALTER TABLE target_export_batches
  ALTER COLUMN campaign_id SET STATISTICS 1000,
  SET (
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_analyze_threshold = 100
  );

ALTER TABLE target_export_batch_items
  SET (
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_analyze_threshold = 100
  );

ANALYZE target_export_batches (campaign_id);
ANALYZE target_export_batch_items (batch_id, job_id);
