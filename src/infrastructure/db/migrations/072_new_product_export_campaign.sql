ALTER TABLE target_export_campaigns
  DROP CONSTRAINT target_export_campaigns_mode_check;

ALTER TABLE target_export_campaigns
  ADD CONSTRAINT target_export_campaigns_mode_check
  CHECK (mode IN ('safe', 'full_existing', 'new_products'));
