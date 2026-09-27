CREATE INDEX wordpress_catalog_run_items_latest_inventory_idx
  ON wordpress_catalog_run_items (run_id, variation_checked_at DESC, id DESC)
  WHERE variation_checked_at IS NOT NULL
    AND match_status = 'matched'
    AND internal_product_id IS NOT NULL;

CREATE INDEX wordpress_inventory_donor_latest_idx
  ON wordpress_inventory_donor_states (run_id, donor_code, checked_at DESC, item_id DESC);
