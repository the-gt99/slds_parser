ALTER TABLE wordpress_catalog_runs
  ADD COLUMN variation_auto_status TEXT NOT NULL DEFAULT 'inactive'
    CHECK (variation_auto_status IN ('inactive', 'running', 'paused', 'completed')),
  ADD COLUMN variation_auto_window INTEGER NOT NULL DEFAULT 5000
    CHECK (variation_auto_window BETWEEN 1 AND 5000),
  ADD COLUMN variation_auto_acknowledged_failed_count BIGINT NOT NULL DEFAULT 0
    CHECK (variation_auto_acknowledged_failed_count >= 0),
  ADD COLUMN variation_auto_error TEXT,
  ADD COLUMN variation_auto_started_at TIMESTAMPTZ,
  ADD COLUMN variation_auto_completed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX wordpress_catalog_runs_variation_auto_idx
  ON wordpress_catalog_runs (variation_auto_status)
  WHERE variation_auto_status = 'running';
