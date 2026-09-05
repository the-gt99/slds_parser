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
    'collect_wordpress_variation_source',
    'prepare_wordpress_variation_patch',
    'submit_wordpress_variation_patches',
    'poll_wordpress_variation_patches',
    'refresh_export_source',
    'export_product'
  )
);

ALTER TABLE wordpress_catalog_run_items
  ADD COLUMN variation_source_hash TEXT,
  ADD COLUMN variation_applied_source_hash TEXT,
  ADD COLUMN variation_source_variants JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN variation_sync_cycle BIGINT NOT NULL DEFAULT 0 CHECK (variation_sync_cycle >= 0);

ALTER TABLE wordpress_catalog_runs
  ADD COLUMN variation_discovery_job_id BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  ADD COLUMN variation_discovery_completed_at TIMESTAMPTZ;

ALTER TABLE source_products
  ADD COLUMN discovery_fingerprint TEXT,
  ADD COLUMN discovery_changed_at TIMESTAMPTZ;

CREATE INDEX source_products_discovery_priority_idx
  ON source_products (source_id, discovery_changed_at DESC NULLS LAST, first_seen_at DESC, id DESC);

CREATE INDEX wordpress_catalog_run_items_variation_cycle_idx
  ON wordpress_catalog_run_items (run_id, variation_sync_cycle, id)
  WHERE match_status = 'matched' AND internal_product_id IS NOT NULL;

CREATE INDEX wordpress_catalog_run_items_variation_ready_idx
  ON wordpress_catalog_run_items (run_id, id)
  WHERE variation_status = 'ready';
