INSERT INTO reference_types (code, name)
VALUES
  ('model', 'Модель'),
  ('product_family', 'Семейство товара'),
  ('size', 'Размер'),
  ('tag', 'Метка'),
  ('material', 'Материал'),
  ('season', 'Сезон'),
  ('shoe_height', 'Высота обуви')
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    updated_at = NOW();

CREATE TABLE source_reference_mappings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES sources(id),
  reference_type_id BIGINT NOT NULL REFERENCES reference_types(id),
  scope TEXT NOT NULL,
  source_value TEXT NOT NULL,
  normalized_source_value TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::JSONB,
  context_key TEXT NOT NULL,
  reference_value_id BIGINT REFERENCES reference_values(id),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'ignored')),
  method TEXT NOT NULL DEFAULT 'manual',
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'confirmed' AND reference_value_id IS NOT NULL)
    OR (status = 'ignored' AND reference_value_id IS NULL)
  ),
  UNIQUE (
    source_id,
    reference_type_id,
    scope,
    normalized_source_value,
    context_key
  )
);

CREATE INDEX source_reference_mappings_reference_value_idx
  ON source_reference_mappings (reference_value_id)
  WHERE reference_value_id IS NOT NULL;

CREATE TABLE source_reference_rules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT REFERENCES sources(id),
  reference_type_id BIGINT NOT NULL REFERENCES reference_types(id),
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  conditions JSONB NOT NULL,
  reference_value_id BIGINT NOT NULL REFERENCES reference_values(id),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (JSONB_TYPEOF(conditions) = 'array')
);

CREATE INDEX source_reference_rules_lookup_idx
  ON source_reference_rules (reference_type_id, source_id, enabled, priority DESC);

CREATE TABLE source_reference_observations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES sources(id),
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  candidate_key TEXT NOT NULL,
  reference_type_id BIGINT NOT NULL REFERENCES reference_types(id),
  scope TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('product', 'variant')),
  subject_key TEXT NOT NULL DEFAULT '',
  source_value TEXT NOT NULL,
  normalized_source_value TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::JSONB,
  context_key TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL CHECK (status IN ('resolved', 'ignored', 'unresolved', 'ambiguous')),
  issue_reason TEXT,
  resolved_reference_value_id BIGINT REFERENCES reference_values(id),
  mapping_id BIGINT REFERENCES source_reference_mappings(id),
  rule_id BIGINT REFERENCES source_reference_rules(id),
  resolution_revision BIGINT,
  classifier_version TEXT NOT NULL,
  classification_fingerprint TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'resolved'
      AND resolved_reference_value_id IS NOT NULL
      AND NUM_NONNULLS(mapping_id, rule_id) = 1
      AND resolution_revision IS NOT NULL)
    OR (status = 'ignored'
      AND resolved_reference_value_id IS NULL
      AND mapping_id IS NOT NULL
      AND rule_id IS NULL
      AND resolution_revision IS NOT NULL)
    OR (status IN ('unresolved', 'ambiguous')
      AND resolved_reference_value_id IS NULL
      AND mapping_id IS NULL
      AND rule_id IS NULL
      AND resolution_revision IS NULL)
  ),
  UNIQUE (source_product_id, candidate_key)
);

CREATE INDEX source_reference_observations_review_idx
  ON source_reference_observations (
    source_id,
    reference_type_id,
    status,
    normalized_source_value
  )
  WHERE active = TRUE AND status IN ('unresolved', 'ambiguous');

CREATE INDEX source_reference_observations_mapping_idx
  ON source_reference_observations (mapping_id)
  WHERE active = TRUE AND mapping_id IS NOT NULL;

CREATE INDEX source_reference_observations_rule_idx
  ON source_reference_observations (rule_id)
  WHERE active = TRUE AND rule_id IS NOT NULL;

CREATE TABLE source_reference_decision_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mapping_id BIGINT REFERENCES source_reference_mappings(id) ON DELETE SET NULL,
  rule_id BIGINT REFERENCES source_reference_rules(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  previous_value JSONB,
  new_value JSONB,
  actor TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NUM_NONNULLS(mapping_id, rule_id) = 1)
);

CREATE INDEX source_reference_decision_history_mapping_idx
  ON source_reference_decision_history (mapping_id, created_at DESC)
  WHERE mapping_id IS NOT NULL;

CREATE INDEX source_reference_decision_history_rule_idx
  ON source_reference_decision_history (rule_id, created_at DESC)
  WHERE rule_id IS NOT NULL;

INSERT INTO source_reference_mappings (
  source_id,
  reference_type_id,
  scope,
  source_value,
  normalized_source_value,
  context,
  context_key,
  reference_value_id,
  status,
  method,
  revision,
  decided_at,
  created_at,
  updated_at
)
SELECT
  source_id,
  reference_type_id,
  scope,
  source_value,
  normalized_source_value,
  '{}'::JSONB,
  '{}',
  reference_value_id,
  'confirmed',
  'legacy_migration',
  1,
  updated_at,
  created_at,
  updated_at
FROM source_value_mappings
WHERE status = 'confirmed'
ON CONFLICT (
  source_id,
  reference_type_id,
  scope,
  normalized_source_value,
  context_key
) DO NOTHING;
