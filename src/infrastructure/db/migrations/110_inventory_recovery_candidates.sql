-- migrate: concurrent-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS wordpress_catalog_run_items_recovery_idx
ON wordpress_catalog_run_items (run_id, id) INCLUDE (updated_at)
WHERE variation_status IN ('pending','refreshing','submitted');
