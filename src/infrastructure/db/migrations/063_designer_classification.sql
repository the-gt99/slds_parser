INSERT INTO reference_types (code, name, cardinality, allowed_subject_kinds, metadata, enabled)
VALUES ('designer', 'Дизайнер', 'multiple', ARRAY['product']::TEXT[], '{}'::JSONB, TRUE)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    cardinality = EXCLUDED.cardinality,
    allowed_subject_kinds = EXCLUDED.allowed_subject_kinds,
    enabled = TRUE,
    updated_at = NOW();
