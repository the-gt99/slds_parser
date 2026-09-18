CREATE INDEX CONCURRENTLY IF NOT EXISTS source_products_sneakers_scan_idx
  ON source_products (id DESC)
  WHERE discovery_metadata->>'route' = 'sneakers';
