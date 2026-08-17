ALTER TABLE target_export_campaigns
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'safe'
    CHECK (mode IN ('safe', 'full_existing')),
  ADD COLUMN catalog_run_id BIGINT REFERENCES wordpress_catalog_runs(id);

ALTER TABLE target_export_campaigns
  ADD CONSTRAINT target_export_campaigns_full_existing_catalog_check
  CHECK (mode <> 'full_existing' OR catalog_run_id IS NOT NULL);

CREATE INDEX target_export_campaigns_catalog_run_idx
  ON target_export_campaigns (catalog_run_id)
  WHERE catalog_run_id IS NOT NULL;
