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
          (rule.source_id IS NOT NULL) DESC,
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
