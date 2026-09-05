ALTER TABLE wordpress_catalog_run_items
  ADD COLUMN variation_next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN variation_unchanged_streak INTEGER NOT NULL DEFAULT 0 CHECK (variation_unchanged_streak >= 0),
  ADD COLUMN variation_last_changed_at TIMESTAMPTZ;

CREATE INDEX wordpress_catalog_run_items_variation_due_idx
  ON wordpress_catalog_run_items (run_id, variation_next_check_at, id)
  WHERE match_status = 'matched' AND internal_product_id IS NOT NULL;
