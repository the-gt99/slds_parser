-- migrate: concurrent-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_failed_inventory_item_idx
  ON jobs (job_type, (payload->>'itemId'), finished_at DESC)
  WHERE status = 'failed'
    AND job_type IN ('collect_wordpress_goat_inventory', 'collect_wordpress_shihuo_inventory');
