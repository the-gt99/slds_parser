CREATE TEMP TABLE migrated_global_rule_ids (
  id BIGINT PRIMARY KEY
) ON COMMIT DROP;

DO $$
DECLARE
  goat_source_id BIGINT;
BEGIN
  INSERT INTO migrated_global_rule_ids (id)
  SELECT id FROM source_reference_rules WHERE source_id IS NULL;

  IF EXISTS (SELECT 1 FROM migrated_global_rule_ids) THEN
    SELECT id INTO goat_source_id FROM sources WHERE code = 'goat';
    IF goat_source_id IS NULL THEN
      RAISE EXCEPTION 'GOAT source is required to assign legacy global classification rules';
    END IF;

    WITH selected AS (
      SELECT rule.id, TO_JSONB(rule) AS previous_value
      FROM source_reference_rules rule
      JOIN migrated_global_rule_ids migrated ON migrated.id = rule.id
    ), updated AS (
      UPDATE source_reference_rules rule
      SET source_id = goat_source_id,
          revision = rule.revision + 1,
          updated_by = 'migration:037',
          updated_at = NOW()
      FROM selected
      WHERE rule.id = selected.id
      RETURNING rule.id, selected.previous_value, TO_JSONB(rule) AS new_value
    )
    INSERT INTO source_reference_decision_history (
      rule_id, action, previous_value, new_value, actor, reason
    )
    SELECT id, 'update', previous_value, new_value, 'migration:037',
           'Глобальное правило закреплено за единственным источником GOAT'
    FROM updated;
  END IF;
END;
$$;

ALTER TABLE source_reference_rules
  ALTER COLUMN source_id SET NOT NULL;

CREATE OR REPLACE FUNCTION classification_review_rule_resolutions(observation_ids BIGINT[])
RETURNS TABLE (observation_id BIGINT, rule_id BIGINT)
LANGUAGE sql
STABLE
AS $$
  WITH ranked AS (
    SELECT
      coverage.observation_id,
      rule.id AS rule_id,
      rule.reference_value_id,
      DENSE_RANK() OVER (
        PARTITION BY coverage.observation_id
        ORDER BY rule.priority DESC,
          JSONB_ARRAY_LENGTH(rule.conditions) DESC
      ) AS score_rank
    FROM classification_review_rule_coverage coverage
    JOIN source_reference_rules rule
      ON rule.id = coverage.rule_id
     AND rule.revision = coverage.rule_revision
     AND rule.enabled = TRUE
     AND rule.deleted_at IS NULL
    JOIN reference_values value
      ON value.id = rule.reference_value_id
     AND value.enabled = TRUE
    WHERE observation_ids IS NULL
      OR coverage.observation_id = ANY(observation_ids)
  )
  SELECT ranked.observation_id,
    (ARRAY_AGG(ranked.rule_id ORDER BY ranked.rule_id::TEXT))[1] AS rule_id
  FROM ranked
  WHERE ranked.score_rank = 1
  GROUP BY ranked.observation_id
  HAVING COUNT(DISTINCT ranked.reference_value_id) = 1;
$$;

CREATE OR REPLACE FUNCTION rebuild_classification_review_rule_coverage()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  TRUNCATE classification_review_rule_coverage;
  INSERT INTO classification_review_rule_coverage (
    observation_id, rule_id, rule_revision
  )
  SELECT observation.id, rule.id, rule.revision
  FROM classification_observation_read_model observation
  JOIN source_reference_rules rule
    ON rule.reference_type_id = observation.reference_type_id
   AND rule.source_id = observation.source_id
   AND rule.enabled = TRUE
   AND rule.deleted_at IS NULL
  JOIN reference_values value
    ON value.id = rule.reference_value_id
   AND value.enabled = TRUE
  WHERE observation.active = TRUE
    AND observation.status IN ('unresolved', 'ambiguous')
    AND classification_rule_matches_observation(
      rule.conditions,
      observation.source_value,
      observation.scope,
      observation.subject_kind,
      observation.context,
      observation.evidence
    );
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM migrated_global_rule_ids) THEN
    PERFORM rebuild_classification_review_read_model();
  END IF;
END;
$$;
