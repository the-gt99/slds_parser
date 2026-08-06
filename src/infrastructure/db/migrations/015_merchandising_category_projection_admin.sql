INSERT INTO reference_types (code, name, cardinality, allowed_subject_kinds, metadata, enabled)
VALUES ('merchandising_category', 'Маркетинговая категория', 'multiple', ARRAY['product']::TEXT[], '{}'::JSONB, TRUE)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    cardinality = EXCLUDED.cardinality,
    allowed_subject_kinds = EXCLUDED.allowed_subject_kinds,
    enabled = TRUE,
    updated_at = NOW();

CREATE TABLE target_classification_projection_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  projection_id BIGINT REFERENCES target_classification_projections(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'reactivate', 'deactivate')),
  previous_value JSONB,
  new_value JSONB,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX target_classification_projection_history_projection_idx
  ON target_classification_projection_history (projection_id, created_at DESC);
