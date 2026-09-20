CREATE TABLE rules_v2_reference_types (
  code TEXT PRIMARY KEY,
  cardinality TEXT NOT NULL CHECK (cardinality IN ('single', 'multiple')),
  allowed_subject_kinds TEXT[] NOT NULL CHECK (
    CARDINALITY(allowed_subject_kinds) > 0
    AND allowed_subject_kinds <@ ARRAY['product', 'variant']::TEXT[]
  ),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (JSONB_TYPEOF(metadata) = 'object'),
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO rules_v2_reference_types (code, cardinality, allowed_subject_kinds, metadata, enabled)
SELECT code, cardinality, allowed_subject_kinds, metadata, enabled
FROM reference_types;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM rules_v2 rule WHERE rule.status = 'shadow'
      AND rule.actions->0->>'kind' = 'resolve_reference'
      AND rule.actions->0->>'resolutionStatus' <> 'ignored'
      AND NOT EXISTS (
        SELECT 1 FROM reference_values value
        WHERE value.id::TEXT = rule.actions->0->>'referenceValueId' AND value.enabled = TRUE
      )
  ) THEN
    UPDATE rules_v2 rule SET status = 'disabled', revision = rule.revision + 1, updated_at = NOW()
    WHERE rule.status = 'shadow'
      AND rule.actions->0->>'kind' = 'resolve_reference'
      AND rule.actions->0->>'resolutionStatus' <> 'ignored'
      AND NOT EXISTS (
        SELECT 1 FROM reference_values value
        WHERE value.id::TEXT = rule.actions->0->>'referenceValueId' AND value.enabled = TRUE
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION invalidate_rules_execution() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE rules_execution_control SET revision = revision + 1, updated_at = NOW();
  IF TG_TABLE_NAME IN ('rules_v2', 'rules_v2_reference_types') THEN
    UPDATE target_export_revisions SET revision = revision + 1;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER invalidate_rules_execution
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON rules_v2_reference_types
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_rules_execution();
