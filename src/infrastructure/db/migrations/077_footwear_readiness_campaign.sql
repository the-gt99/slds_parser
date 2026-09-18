ALTER TABLE target_export_campaigns
  DROP CONSTRAINT target_export_campaigns_mode_check;

ALTER TABLE target_export_campaigns
  ADD CONSTRAINT target_export_campaigns_mode_check
  CHECK (mode IN ('safe', 'full_existing', 'new_products', 'footwear_readiness'));

ALTER TABLE target_export_campaigns
  DROP CONSTRAINT target_export_campaigns_full_existing_catalog_check;

ALTER TABLE target_export_campaigns
  ADD CONSTRAINT target_export_campaigns_catalog_scope_check
  CHECK (mode NOT IN ('full_existing', 'footwear_readiness') OR catalog_run_id IS NOT NULL);

ALTER TABLE target_export_campaigns
  ADD COLUMN scanned_count BIGINT NOT NULL DEFAULT 0;
