ALTER TABLE target_export_campaigns
  ADD COLUMN scan_before_internal_product_id BIGINT,
  ADD COLUMN scan_complete BOOLEAN NOT NULL DEFAULT FALSE;
