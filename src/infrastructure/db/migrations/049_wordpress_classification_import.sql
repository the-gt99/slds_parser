ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (
  job_type IN (
    'discover_source',
    'collect_product',
    'process_product',
    'sync_target_classifications',
    'preflight_product',
    'export_product'
  )
);

CREATE TABLE target_classification_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  source_id BIGINT NOT NULL REFERENCES sources(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  cursor BIGINT NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  fetched_product_count BIGINT NOT NULL DEFAULT 0 CHECK (fetched_product_count >= 0),
  matched_source_product_count BIGINT NOT NULL DEFAULT 0 CHECK (matched_source_product_count >= 0),
  assignment_count BIGINT NOT NULL DEFAULT 0 CHECK (assignment_count >= 0),
  suggestion_count BIGINT NOT NULL DEFAULT 0 CHECK (suggestion_count >= 0),
  ready_suggestion_count BIGINT NOT NULL DEFAULT 0 CHECK (ready_suggestion_count >= 0),
  conflict_suggestion_count BIGINT NOT NULL DEFAULT 0 CHECK (conflict_suggestion_count >= 0),
  requested_by TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX target_classification_sync_runs_active_idx
  ON target_classification_sync_runs (target_id, source_id)
  WHERE status IN ('pending', 'running');

CREATE INDEX target_classification_sync_runs_latest_idx
  ON target_classification_sync_runs (target_id, source_id, created_at DESC, id DESC);

CREATE TABLE target_classification_import_products (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES target_classification_sync_runs(id) ON DELETE CASCADE,
  target_external_id TEXT NOT NULL,
  source_external_id TEXT NOT NULL,
  source_product_id BIGINT REFERENCES source_products(id),
  taxonomies JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT target_classification_import_products_taxonomies_check
    CHECK (JSONB_TYPEOF(taxonomies) = 'object'),
  UNIQUE (run_id, target_external_id)
);

CREATE INDEX target_classification_import_products_source_idx
  ON target_classification_import_products (run_id, source_product_id)
  WHERE source_product_id IS NOT NULL;

CREATE TABLE target_classification_suggestions (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES target_classification_sync_runs(id) ON DELETE CASCADE,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  source_id BIGINT NOT NULL REFERENCES sources(id),
  type_code TEXT NOT NULL,
  suggestion_kind TEXT NOT NULL CHECK (suggestion_kind IN ('mapping', 'rule')),
  group_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  normalized_source_value TEXT NOT NULL,
  context_key TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::JSONB,
  source_value TEXT NOT NULL,
  target_scope TEXT NOT NULL,
  dictionary_value_id BIGINT REFERENCES target_dictionary_values(id),
  external_value TEXT,
  target_name TEXT,
  matched_product_count BIGINT NOT NULL CHECK (matched_product_count > 0),
  evidence_product_count BIGINT NOT NULL CHECK (evidence_product_count >= 0),
  missing_target_count BIGINT NOT NULL CHECK (missing_target_count >= 0),
  target_counts JSONB NOT NULL DEFAULT '[]'::JSONB,
  status TEXT NOT NULL CHECK (status IN ('ready', 'conflict', 'applied')),
  issue_reason TEXT,
  applied_resolution_kind TEXT CHECK (applied_resolution_kind IS NULL OR applied_resolution_kind IN ('mapping', 'rule')),
  applied_resolution_id BIGINT,
  applied_at TIMESTAMPTZ,
  applied_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT target_classification_suggestions_context_check CHECK (JSONB_TYPEOF(context) = 'object'),
  CONSTRAINT target_classification_suggestions_counts_check CHECK (JSONB_TYPEOF(target_counts) = 'array'),
  UNIQUE (run_id, type_code, suggestion_kind, group_key)
);

CREATE INDEX target_classification_suggestions_list_idx
  ON target_classification_suggestions (run_id, status, matched_product_count DESC, id DESC);

CREATE INDEX jobs_target_classification_sync_active_idx
  ON jobs (job_type, unique_key)
  WHERE job_type = 'sync_target_classifications' AND status IN ('pending', 'running', 'retry');
