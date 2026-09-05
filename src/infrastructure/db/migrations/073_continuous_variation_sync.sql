ALTER TABLE wordpress_catalog_runs
  ADD COLUMN variation_sync_interval_minutes INTEGER NOT NULL DEFAULT 360
    CHECK (variation_sync_interval_minutes BETWEEN 5 AND 10080),
  ADD COLUMN variation_sync_cycle BIGINT NOT NULL DEFAULT 0
    CHECK (variation_sync_cycle >= 0),
  ADD COLUMN variation_sync_last_cycle_started_at TIMESTAMPTZ,
  ADD COLUMN variation_sync_last_cycle_completed_at TIMESTAMPTZ,
  ADD COLUMN variation_sync_next_cycle_at TIMESTAMPTZ;

CREATE INDEX wordpress_catalog_runs_variation_sync_due_idx
  ON wordpress_catalog_runs (variation_sync_next_cycle_at)
  WHERE variation_auto_status = 'running';

CREATE TABLE goat_proxy_session_leases (
  proxy_id BIGINT NOT NULL REFERENCES goat_proxies(id) ON DELETE CASCADE,
  session_slot INTEGER NOT NULL CHECK (session_slot > 0),
  owner_id TEXT NOT NULL,
  leased_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (proxy_id, session_slot)
);

CREATE INDEX goat_proxy_session_leases_expiry_idx
  ON goat_proxy_session_leases (leased_until);
