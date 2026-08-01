CREATE TABLE sources (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  adapter_code TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::JSONB,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE source_collection_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES sources(id),
  run_type TEXT NOT NULL,
  coverage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial', 'unknown')),
  checkpoint JSONB NOT NULL DEFAULT '{}'::JSONB,
  processed_count BIGINT NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  discovered_count BIGINT NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  error_count BIGINT NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  last_error TEXT
);

CREATE UNIQUE INDEX source_collection_runs_one_running_per_source_idx
  ON source_collection_runs (source_id)
  WHERE status = 'running';
CREATE INDEX source_collection_runs_source_started_idx
  ON source_collection_runs (source_id, started_at DESC);

CREATE TABLE source_products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES sources(id),
  source_key TEXT NOT NULL,
  external_id TEXT,
  slug TEXT,
  url TEXT,
  discovery_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_run_id BIGINT REFERENCES source_collection_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, source_key)
);

CREATE UNIQUE INDEX source_products_source_external_id_idx
  ON source_products (source_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX source_products_last_seen_run_idx
  ON source_products (last_seen_run_id);
CREATE INDEX source_products_source_status_idx
  ON source_products (source_id, status);

CREATE TABLE source_product_parts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  part_key TEXT NOT NULL,
  raw_payload JSONB NOT NULL,
  parsed_payload JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  source_updated_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL,
  adapter_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_product_id, part_key)
);

CREATE TABLE reference_types (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE reference_values (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type_id BIGINT NOT NULL REFERENCES reference_types(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id BIGINT REFERENCES reference_values(id),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (type_id, code)
);

CREATE INDEX reference_values_parent_idx ON reference_values (parent_id);
CREATE INDEX reference_values_type_enabled_idx
  ON reference_values (type_id, enabled);

CREATE TABLE source_value_mappings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES sources(id),
  reference_type_id BIGINT NOT NULL REFERENCES reference_types(id),
  scope TEXT NOT NULL DEFAULT '',
  source_value TEXT NOT NULL,
  normalized_source_value TEXT NOT NULL,
  reference_value_id BIGINT NOT NULL REFERENCES reference_values(id),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'suggested', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, reference_type_id, scope, normalized_source_value)
);

CREATE INDEX source_value_mappings_reference_value_idx
  ON source_value_mappings (reference_value_id);

CREATE TABLE internal_products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_product_id BIGINT NOT NULL UNIQUE REFERENCES source_products(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  input_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  status TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX internal_products_status_idx ON internal_products (status);

CREATE TABLE targets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  exporter_code TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::JSONB,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE target_value_mappings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  reference_value_id BIGINT NOT NULL REFERENCES reference_values(id),
  target_scope TEXT NOT NULL DEFAULT '',
  external_value TEXT NOT NULL,
  external_label TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_id, reference_value_id, target_scope)
);

CREATE INDEX target_value_mappings_reference_value_idx
  ON target_value_mappings (reference_value_id);

CREATE TABLE target_products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  internal_product_id BIGINT NOT NULL REFERENCES internal_products(id) ON DELETE CASCADE,
  external_id TEXT,
  status TEXT NOT NULL,
  last_exported_hash TEXT,
  last_export_fingerprint TEXT,
  last_attempt_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_id, internal_product_id)
);

CREATE UNIQUE INDEX target_products_target_external_id_idx
  ON target_products (target_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX target_products_internal_product_idx
  ON target_products (internal_product_id);
CREATE INDEX target_products_target_status_idx
  ON target_products (target_id, status);

CREATE TABLE jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (
    job_type IN ('discover_source', 'collect_product', 'process_product', 'export_product')
  ),
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'retry', 'completed', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  unique_key TEXT NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX jobs_active_unique_key_idx
  ON jobs (job_type, unique_key)
  WHERE status IN ('pending', 'running', 'retry');
CREATE INDEX jobs_available_idx
  ON jobs (available_at, id)
  WHERE status IN ('pending', 'retry');
CREATE INDEX jobs_running_lock_idx
  ON jobs (locked_at)
  WHERE status = 'running';
