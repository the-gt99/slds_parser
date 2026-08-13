ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (
  job_type IN (
    'discover_source',
    'collect_product',
    'process_product',
    'reclassify_product',
    'sync_target_classifications',
    'apply_target_classification_suggestion',
    'preflight_product',
    'export_product',
    'sync_wordpress_catalog',
    'prepare_wordpress_variation_patches',
    'refresh_wordpress_variation_patch',
    'poll_wordpress_variation_patches'
  )
);

CREATE TABLE wordpress_catalog_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  source_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'completed', 'failed')),
  catalog_cursor BIGINT NOT NULL DEFAULT 0 CHECK (catalog_cursor >= 0),
  catalog_complete BOOLEAN NOT NULL DEFAULT FALSE,
  audit_requested BOOLEAN NOT NULL DEFAULT TRUE,
  variation_sync_requested BOOLEAN NOT NULL DEFAULT TRUE,
  actor TEXT NOT NULL,
  reason TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX wordpress_catalog_runs_one_running_idx
  ON wordpress_catalog_runs (target_id)
  WHERE status = 'running';

CREATE INDEX wordpress_catalog_runs_target_created_idx
  ON wordpress_catalog_runs (target_id, created_at DESC, id DESC);

CREATE TABLE wordpress_catalog_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  wordpress_product_id BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_id, wordpress_product_id, content_hash)
);

CREATE INDEX wordpress_catalog_snapshots_latest_idx
  ON wordpress_catalog_snapshots (target_id, wordpress_product_id, fetched_at DESC, id DESC);

CREATE TABLE wordpress_catalog_run_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES wordpress_catalog_runs(id) ON DELETE CASCADE,
  snapshot_id BIGINT NOT NULL REFERENCES wordpress_catalog_snapshots(id),
  wordpress_product_id BIGINT NOT NULL,
  source_code TEXT,
  source_external_id TEXT,
  legacy_goat_id TEXT,
  sku TEXT,
  source_product_id BIGINT REFERENCES source_products(id),
  internal_product_id BIGINT REFERENCES internal_products(id),
  match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'unmatched', 'ambiguous')),
  match_method TEXT,
  match_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  audit_status TEXT NOT NULL DEFAULT 'pending' CHECK (audit_status IN ('pending', 'running', 'ready', 'blocked', 'error', 'skipped')),
  audit_result JSONB,
  audit_error TEXT,
  variation_status TEXT NOT NULL DEFAULT 'pending' CHECK (variation_status IN ('pending', 'refreshing', 'ready', 'submitted', 'completed', 'skipped', 'failed')),
  variation_payload JSONB,
  variation_notices JSONB NOT NULL DEFAULT '[]'::JSONB,
  wordpress_job_id BIGINT,
  variation_result JSONB,
  variation_error TEXT,
  variation_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, wordpress_product_id)
);

CREATE INDEX wordpress_catalog_run_items_match_idx
  ON wordpress_catalog_run_items (run_id, match_status, id);

CREATE INDEX wordpress_catalog_run_items_audit_idx
  ON wordpress_catalog_run_items (run_id, audit_status, id);

CREATE INDEX wordpress_catalog_run_items_variation_idx
  ON wordpress_catalog_run_items (run_id, variation_status, id);

CREATE INDEX wordpress_catalog_run_items_source_product_idx
  ON wordpress_catalog_run_items (source_product_id);

CREATE INDEX wordpress_catalog_run_items_wordpress_job_idx
  ON wordpress_catalog_run_items (wordpress_job_id)
  WHERE wordpress_job_id IS NOT NULL;
