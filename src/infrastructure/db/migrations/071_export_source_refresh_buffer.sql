ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (
  job_type IN (
    'discover_source',
    'collect_product',
    'process_product',
    'reclassify_product',
    'retranslate_product',
    'sync_target_classifications',
    'apply_target_classification_suggestion',
    'preflight_product',
    'sync_wordpress_catalog',
    'prepare_wordpress_variation_patches',
    'refresh_wordpress_variation_patch',
    'poll_wordpress_variation_patches',
    'refresh_export_source',
    'export_product'
  )
);

CREATE TABLE target_export_source_refreshes (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES target_export_campaigns(id) ON DELETE CASCADE,
  target_id BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  internal_product_id BIGINT NOT NULL REFERENCES internal_products(id) ON DELETE CASCADE,
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  internal_content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'error')),
  variants JSONB,
  fetched_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, internal_product_id)
);

CREATE INDEX target_export_source_refreshes_campaign_status_idx
  ON target_export_source_refreshes (campaign_id, status, id);
