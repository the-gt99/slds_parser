CREATE TABLE target_product_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  source_external_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (JSONB_TYPEOF(payload) = 'object'),
  UNIQUE (target_id, source_product_id)
);

CREATE UNIQUE INDEX target_product_snapshots_external_id_idx
  ON target_product_snapshots (target_id, external_id);

CREATE TABLE target_classification_projections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  mapping_id BIGINT REFERENCES source_reference_mappings(id) ON DELETE CASCADE,
  rule_id BIGINT REFERENCES source_reference_rules(id) ON DELETE CASCADE,
  target_scope TEXT NOT NULL,
  dictionary_value_id BIGINT NOT NULL REFERENCES target_dictionary_values(id),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NUM_NONNULLS(mapping_id, rule_id) = 1)
);

CREATE UNIQUE INDEX target_classification_projections_mapping_idx
  ON target_classification_projections (target_id, mapping_id, target_scope, dictionary_value_id)
  WHERE mapping_id IS NOT NULL;

CREATE UNIQUE INDEX target_classification_projections_rule_idx
  ON target_classification_projections (target_id, rule_id, target_scope, dictionary_value_id)
  WHERE rule_id IS NOT NULL;

CREATE INDEX target_classification_projections_dictionary_idx
  ON target_classification_projections (dictionary_value_id)
  WHERE active = TRUE;
