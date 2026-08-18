CREATE INDEX wordpress_catalog_run_items_run_internal_match_idx
  ON wordpress_catalog_run_items (run_id, internal_product_id)
  WHERE match_status = 'matched' AND internal_product_id IS NOT NULL;
