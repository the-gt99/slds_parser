ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (
  job_type IN (
    'discover_source', 'collect_product', 'process_product', 'reclassify_product', 'retranslate_product',
    'sync_target_classifications', 'apply_target_classification_suggestion', 'preflight_product',
    'sync_wordpress_catalog', 'prepare_wordpress_variation_patches', 'collect_wordpress_variation_source',
    'collect_wordpress_goat_inventory', 'collect_wordpress_shihuo_inventory',
    'prepare_wordpress_variation_patch', 'submit_wordpress_variation_patches', 'poll_wordpress_variation_patches',
    'refresh_export_source', 'resolve_shihuo_product', 'export_product'
  )
);

CREATE TABLE wordpress_inventory_donor_states (
  run_id BIGINT NOT NULL REFERENCES wordpress_catalog_runs(id) ON DELETE CASCADE,
  item_id BIGINT NOT NULL REFERENCES wordpress_catalog_run_items(id) ON DELETE CASCADE,
  donor_code TEXT NOT NULL CHECK (donor_code IN ('goat', 'shihuo')),
  outcome TEXT NOT NULL CHECK (outcome IN ('resolved', 'not_found', 'article_mismatch')),
  content_hash TEXT NOT NULL,
  variants JSONB NOT NULL DEFAULT '[]'::JSONB,
  checked_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, donor_code)
);

CREATE INDEX wordpress_inventory_donor_due_idx
  ON wordpress_inventory_donor_states (run_id, donor_code, checked_at, item_id);
