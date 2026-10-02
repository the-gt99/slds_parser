CREATE INDEX IF NOT EXISTS wordpress_catalog_run_items_inventory_eligible_idx
  ON wordpress_catalog_run_items (run_id, id)
  INCLUDE (wordpress_product_id)
  WHERE match_status = 'matched' AND internal_product_id IS NOT NULL;

ALTER TABLE wordpress_catalog_run_items SET (
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.01
);

ALTER TABLE wordpress_inventory_donor_states SET (
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.01
);
