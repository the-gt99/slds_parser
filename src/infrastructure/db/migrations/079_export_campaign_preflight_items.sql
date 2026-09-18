ALTER TABLE target_export_campaigns
  ADD COLUMN candidates_prepared BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN candidate_count BIGINT NOT NULL DEFAULT 0;

CREATE TABLE target_export_campaign_preflight_items (
  campaign_id BIGINT NOT NULL REFERENCES target_export_campaigns(id) ON DELETE CASCADE,
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  internal_product_id BIGINT NOT NULL REFERENCES internal_products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, source_product_id),
  UNIQUE (campaign_id, internal_product_id)
);
