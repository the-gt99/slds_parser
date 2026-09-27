ALTER TABLE wordpress_catalog_runs
  ADD COLUMN goat_inventory_status TEXT NOT NULL DEFAULT 'inactive'
    CHECK (goat_inventory_status IN ('inactive','running','paused','completed')),
  ADD COLUMN shihuo_inventory_status TEXT NOT NULL DEFAULT 'inactive'
    CHECK (shihuo_inventory_status IN ('inactive','running','paused','completed')),
  ADD COLUMN wordpress_inventory_status TEXT NOT NULL DEFAULT 'inactive'
    CHECK (wordpress_inventory_status IN ('inactive','running','paused','completed'));

UPDATE wordpress_catalog_runs
SET goat_inventory_status = variation_auto_status,
    shihuo_inventory_status = variation_auto_status,
    wordpress_inventory_status = variation_auto_status
WHERE variation_auto_status IN ('running','paused','completed');

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (
  job_type IN (
    'discover_source', 'collect_product', 'process_product', 'reclassify_product', 'retranslate_product',
    'sync_target_classifications', 'apply_target_classification_suggestion', 'preflight_product',
    'sync_wordpress_catalog', 'prepare_wordpress_variation_patches', 'collect_wordpress_variation_source',
    'collect_wordpress_goat_inventory', 'collect_wordpress_shihuo_inventory', 'combine_wordpress_inventory',
    'prepare_wordpress_variation_patch', 'refresh_wordpress_variation_patch',
    'submit_wordpress_variation_patches', 'poll_wordpress_variation_patches',
    'refresh_export_source', 'resolve_shihuo_product', 'export_product'
  )
);

CREATE INDEX wordpress_inventory_ready_merge_idx
  ON wordpress_inventory_donor_states (run_id, item_id, donor_code, checked_at);
