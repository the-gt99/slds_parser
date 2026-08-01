ALTER TABLE reference_types
  ADD COLUMN cardinality TEXT NOT NULL DEFAULT 'single'
    CHECK (cardinality IN ('single', 'multiple')),
  ADD COLUMN allowed_subject_kinds TEXT[] NOT NULL DEFAULT ARRAY['product']::TEXT[],
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD CHECK (
    CARDINALITY(allowed_subject_kinds) > 0
    AND allowed_subject_kinds <@ ARRAY['product', 'variant']::TEXT[]
  );

UPDATE reference_types
SET cardinality = CASE
      WHEN code IN ('category', 'tag', 'material') THEN 'multiple'
      ELSE 'single'
    END,
    allowed_subject_kinds = CASE
      WHEN code IN ('size', 'condition', 'box_condition') THEN ARRAY['variant']::TEXT[]
      ELSE ARRAY['product']::TEXT[]
    END,
    updated_at = NOW();
