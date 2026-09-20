CREATE TABLE rules_execution_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode TEXT NOT NULL DEFAULT 'v1' CHECK (mode IN ('v1', 'v2')),
  revision BIGINT NOT NULL DEFAULT 1,
  legacy_revision BIGINT NOT NULL DEFAULT 1,
  freeze_legacy BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO rules_execution_control (singleton) VALUES (TRUE);

CREATE TABLE rules_execution_history (
  id BIGSERIAL PRIMARY KEY,
  previous_mode TEXT NOT NULL,
  mode TEXT NOT NULL,
  revision BIGINT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION guard_legacy_rules_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE closed BOOLEAN;
BEGIN
  SELECT freeze_legacy OR mode = 'v2' INTO closed FROM rules_execution_control WHERE singleton FOR UPDATE;
  IF closed THEN
    RAISE EXCEPTION 'Старый контур правил закрыт для изменений. Используйте Rules v2.';
  END IF;
  UPDATE rules_execution_control SET legacy_revision = legacy_revision + 1, updated_at = NOW();
  RETURN NULL;
END;
$$;

CREATE FUNCTION invalidate_rules_execution() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE rules_execution_control SET revision = revision + 1, updated_at = NOW();
  -- Existing preflight caches use these revisions independently of the chosen engine.
  IF TG_TABLE_NAME = 'rules_v2' THEN
    UPDATE target_export_revisions SET revision = revision + 1;
  END IF;
  RETURN NULL;
END;
$$;

DO $$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'source_reference_mappings', 'source_reference_rules', 'target_value_mappings',
    'target_classification_projections', 'target_reference_projections',
    'target_assignment_rules', 'target_assignment_rule_actions',
    'target_assignment_rule_condition_groups', 'target_assignment_rule_conditions', 'target_assignment_rule_condition_values',
    'target_assignment_match_sets', 'target_assignment_match_set_values', 'reference_values', 'reference_types'
  ] LOOP
    EXECUTE format('CREATE TRIGGER guard_rules_execution BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION guard_legacy_rules_write()', relation_name);
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY['rules_v2', 'target_dictionary_values', 'reference_values', 'reference_types'] LOOP
    EXECUTE format('CREATE TRIGGER invalidate_rules_execution AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION invalidate_rules_execution()', relation_name);
  END LOOP;
END;
$$;
