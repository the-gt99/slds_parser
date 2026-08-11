DROP INDEX IF EXISTS target_product_preflight_reviews_source_refresh_idx;

ALTER TABLE target_product_preflight_reviews
  DROP COLUMN IF EXISTS source_refreshed_at;

ALTER TABLE runtime_worker_settings
  ADD COLUMN refresh_source_before_export BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN applied_refresh_source_before_export BOOLEAN;

UPDATE runtime_worker_settings
SET applied_refresh_source_before_export = refresh_source_before_export
WHERE applied_revision IS NOT NULL;

ALTER TABLE runtime_worker_settings
  ADD CHECK (
    (applied_revision IS NULL AND applied_refresh_source_before_export IS NULL)
    OR
    (applied_revision IS NOT NULL AND applied_refresh_source_before_export IS NOT NULL)
  );
