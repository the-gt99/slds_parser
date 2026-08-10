CREATE TABLE target_reference_projections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  reference_value_id BIGINT NOT NULL REFERENCES reference_values(id),
  target_scope TEXT NOT NULL,
  dictionary_value_id BIGINT NOT NULL REFERENCES target_dictionary_values(id),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (BTRIM(target_scope) <> ''),
  UNIQUE (target_id, reference_value_id, target_scope, dictionary_value_id)
);

CREATE INDEX target_reference_projections_reference_idx
  ON target_reference_projections (reference_value_id)
  WHERE active = TRUE;

CREATE INDEX target_reference_projections_dictionary_idx
  ON target_reference_projections (dictionary_value_id)
  WHERE active = TRUE;

CREATE TABLE target_reference_projection_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  projection_id BIGINT NOT NULL REFERENCES target_reference_projections(id),
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'reactivate', 'deactivate')),
  previous_value JSONB,
  new_value JSONB NOT NULL,
  actor TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX target_reference_projection_history_projection_idx
  ON target_reference_projection_history (projection_id, created_at DESC);
