CREATE TABLE runtime_worker_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
  collection_concurrency SMALLINT NOT NULL,
  process_concurrency SMALLINT NOT NULL,
  preflight_concurrency SMALLINT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_revision BIGINT,
  applied_collection_concurrency SMALLINT,
  applied_process_concurrency SMALLINT,
  applied_preflight_concurrency SMALLINT,
  applied_worker_id TEXT,
  applied_at TIMESTAMPTZ,
  CHECK (singleton),
  CHECK (collection_concurrency BETWEEN 1 AND 16),
  CHECK (process_concurrency BETWEEN 1 AND 16),
  CHECK (preflight_concurrency BETWEEN 1 AND 8),
  CHECK (revision > 0),
  CHECK (applied_revision IS NULL OR applied_revision > 0),
  CHECK (applied_collection_concurrency IS NULL OR applied_collection_concurrency BETWEEN 1 AND 16),
  CHECK (applied_process_concurrency IS NULL OR applied_process_concurrency BETWEEN 1 AND 16),
  CHECK (applied_preflight_concurrency IS NULL OR applied_preflight_concurrency BETWEEN 1 AND 8),
  CHECK (
    (applied_revision IS NULL
      AND applied_collection_concurrency IS NULL
      AND applied_process_concurrency IS NULL
      AND applied_preflight_concurrency IS NULL
      AND applied_worker_id IS NULL
      AND applied_at IS NULL)
    OR
    (applied_revision IS NOT NULL
      AND applied_collection_concurrency IS NOT NULL
      AND applied_process_concurrency IS NOT NULL
      AND applied_preflight_concurrency IS NOT NULL
      AND applied_worker_id IS NOT NULL
      AND applied_at IS NOT NULL)
  )
);

CREATE TABLE runtime_worker_settings_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision BIGINT NOT NULL UNIQUE,
  previous_settings JSONB NOT NULL,
  settings JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (JSONB_TYPEOF(previous_settings) = 'object'),
  CHECK (JSONB_TYPEOF(settings) = 'object')
);
