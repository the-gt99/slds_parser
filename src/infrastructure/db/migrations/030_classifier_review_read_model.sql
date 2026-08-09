ALTER TABLE source_reference_observations
  ADD COLUMN processor_version TEXT;

UPDATE source_reference_observations observation
SET processor_version = internal.processor_version
FROM internal_products internal
WHERE internal.source_product_id = observation.source_product_id;

ALTER TABLE source_reference_observations
  ALTER COLUMN processor_version SET NOT NULL;

CREATE TABLE classification_review_rule_coverage (
  observation_id BIGINT NOT NULL REFERENCES source_reference_observations(id) ON DELETE CASCADE,
  rule_id BIGINT NOT NULL REFERENCES source_reference_rules(id) ON DELETE CASCADE,
  rule_revision BIGINT NOT NULL CHECK (rule_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (observation_id, rule_id)
);

CREATE INDEX classification_review_rule_coverage_rule_idx
  ON classification_review_rule_coverage (rule_id, observation_id);

CREATE TABLE classification_review_groups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES sources(id),
  reference_type_id BIGINT NOT NULL REFERENCES reference_types(id),
  processor_version TEXT NOT NULL,
  scope TEXT NOT NULL,
  normalized_source_value TEXT NOT NULL,
  context_key TEXT NOT NULL,
  observation_status TEXT NOT NULL CHECK (observation_status IN ('unresolved', 'ambiguous')),
  review_status TEXT NOT NULL CHECK (review_status IN ('unresolved', 'ambiguous', 'waiting_apply')),
  source_value TEXT NOT NULL,
  context JSONB NOT NULL,
  issue_reason TEXT,
  total_observation_count INTEGER NOT NULL CHECK (total_observation_count > 0),
  total_product_count INTEGER NOT NULL CHECK (total_product_count > 0),
  needs_decision_observation_count INTEGER NOT NULL CHECK (needs_decision_observation_count >= 0),
  needs_decision_product_count INTEGER NOT NULL CHECK (needs_decision_product_count >= 0),
  waiting_observation_count INTEGER NOT NULL CHECK (waiting_observation_count >= 0),
  waiting_product_count INTEGER NOT NULL CHECK (waiting_product_count >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (needs_decision_observation_count + waiting_observation_count = total_observation_count),
  CHECK (needs_decision_product_count <= total_product_count),
  CHECK (waiting_product_count <= total_product_count),
  UNIQUE (
    source_id,
    reference_type_id,
    processor_version,
    scope,
    normalized_source_value,
    context_key,
    observation_status
  )
);

CREATE INDEX classification_review_groups_queue_idx
  ON classification_review_groups (
    review_status,
    needs_decision_product_count DESC,
    waiting_product_count DESC,
    last_seen_at DESC,
    id DESC
  );

CREATE INDEX classification_review_groups_source_queue_idx
  ON classification_review_groups (
    source_id,
    reference_type_id,
    review_status,
    needs_decision_product_count DESC,
    waiting_product_count DESC,
    last_seen_at DESC,
    id DESC
  );

CREATE OR REPLACE FUNCTION classification_rule_condition_matches_observation(
  condition JSONB,
  source_value TEXT,
  scope_value TEXT,
  subject_kind_value TEXT,
  context_value JSONB,
  evidence_value JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  field_name TEXT := condition->>'field';
  operator_name TEXT := condition->>'operator';
  expected TEXT := condition->>'value';
  actual TEXT := '';
  normalized_actual TEXT;
  normalized_expected TEXT;
  entry JSONB;
  word TEXT;
BEGIN
  IF field_name = 'sourceValue' THEN
    actual := source_value;
  ELSIF field_name = 'scope' THEN
    actual := scope_value;
  ELSIF field_name = 'subjectKind' THEN
    actual := subject_kind_value;
  ELSIF field_name LIKE 'context.%' THEN
    entry := context_value -> (SUBSTRING(field_name FROM 9));
    IF entry IS NOT NULL AND JSONB_TYPEOF(entry) IN ('string', 'number', 'boolean') THEN
      actual := entry #>> '{}';
    END IF;
  ELSIF field_name LIKE 'evidence.%' THEN
    entry := evidence_value -> (SUBSTRING(field_name FROM 10));
    IF entry IS NOT NULL AND JSONB_TYPEOF(entry) IN ('string', 'number', 'boolean') THEN
      actual := entry #>> '{}';
    END IF;
  ELSE
    RETURN FALSE;
  END IF;

  IF expected IS NULL OR BTRIM(expected) = '' THEN
    RETURN FALSE;
  END IF;

  normalized_actual := LOWER(NORMALIZE(BTRIM(actual), NFKC));
  normalized_expected := LOWER(NORMALIZE(BTRIM(expected), NFKC));
  IF operator_name = 'equals' THEN
    RETURN normalized_actual = normalized_expected;
  ELSIF operator_name = 'contains' THEN
    RETURN POSITION(normalized_expected IN normalized_actual) > 0;
  ELSIF operator_name = 'all_words' THEN
    FOR word IN SELECT REGEXP_SPLIT_TO_TABLE(normalized_expected, '\s+') LOOP
      IF word <> '' AND POSITION(word IN normalized_actual) = 0 THEN
        RETURN FALSE;
      END IF;
    END LOOP;
    RETURN TRUE;
  ELSIF operator_name = 'regex' THEN
    RETURN actual ~* expected;
  END IF;

  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION classification_rule_matches_observation(
  conditions JSONB,
  source_value TEXT,
  scope_value TEXT,
  subject_kind_value TEXT,
  context_value JSONB,
  evidence_value JSONB
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT JSONB_ARRAY_LENGTH(conditions) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(conditions) condition
      WHERE NOT classification_rule_condition_matches_observation(
        condition,
        source_value,
        scope_value,
        subject_kind_value,
        context_value,
        evidence_value
      )
    );
$$;

CREATE OR REPLACE FUNCTION classification_review_group_lock_key(
  source_id BIGINT,
  reference_type_id BIGINT,
  processor_version TEXT,
  scope_value TEXT,
  normalized_source_value TEXT,
  context_key TEXT,
  observation_status TEXT
) RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT HASHTEXTEXTENDED(JSONB_BUILD_ARRAY(
    source_id,
    reference_type_id,
    processor_version,
    scope_value,
    normalized_source_value,
    context_key,
    observation_status
  )::TEXT, 0);
$$;

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
    JOIN source_reference_observations observation
      ON observation.id = coverage.observation_id
    JOIN source_reference_rules rule
      ON rule.id = coverage.rule_id
     AND rule.revision = coverage.rule_revision
     AND rule.enabled = TRUE
     AND rule.deleted_at IS NULL
     AND rule.reference_type_id = observation.reference_type_id
     AND (rule.source_id IS NULL OR rule.source_id = observation.source_id)
    JOIN reference_values value
      ON value.id = rule.reference_value_id
     AND value.enabled = TRUE
    WHERE observation.active = TRUE
      AND observation.status IN ('unresolved', 'ambiguous')
      AND (observation_ids IS NULL OR coverage.observation_id = ANY(observation_ids))
  ), unambiguous AS (
    SELECT ranked.observation_id
    FROM ranked
    WHERE ranked.score_rank = 1
    GROUP BY ranked.observation_id
    HAVING COUNT(DISTINCT ranked.reference_value_id) = 1
  )
  SELECT ranked.observation_id,
    (ARRAY_AGG(ranked.rule_id ORDER BY ranked.rule_id::TEXT))[1] AS rule_id
  FROM ranked
  JOIN unambiguous USING (observation_id)
  WHERE ranked.score_rank = 1
  GROUP BY ranked.observation_id;
$$;

CREATE OR REPLACE FUNCTION refresh_classification_review_groups(
  keys JSONB,
  lock_groups BOOLEAN DEFAULT TRUE
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  group_lock BIGINT;
BEGIN
  IF JSONB_ARRAY_LENGTH(COALESCE(keys, '[]'::JSONB)) = 0 THEN
    RETURN;
  END IF;

  IF lock_groups THEN
    FOR group_lock IN
      SELECT DISTINCT classification_review_group_lock_key(
        item.source_id,
        type.id,
        item.processor_version,
        item.scope,
        item.normalized_source_value,
        item.context_key,
        item.observation_status
      )
      FROM JSONB_TO_RECORDSET(keys) AS item(
        source_id BIGINT,
        type_code TEXT,
        processor_version TEXT,
        scope TEXT,
        normalized_source_value TEXT,
        context_key TEXT,
        observation_status TEXT
      )
      JOIN reference_types type ON type.code = item.type_code
      WHERE item.observation_status IN ('unresolved', 'ambiguous')
      ORDER BY 1
    LOOP
      PERFORM PG_ADVISORY_XACT_LOCK(group_lock);
    END LOOP;
  END IF;

  WITH affected AS (
    SELECT DISTINCT
      item.source_id,
      type.id AS reference_type_id,
      item.processor_version,
      item.scope,
      item.normalized_source_value,
      item.context_key,
      item.observation_status
    FROM JSONB_TO_RECORDSET(keys) AS item(
      source_id BIGINT,
      type_code TEXT,
      processor_version TEXT,
      scope TEXT,
      normalized_source_value TEXT,
      context_key TEXT,
      observation_status TEXT
    )
    JOIN reference_types type ON type.code = item.type_code
    WHERE item.observation_status IN ('unresolved', 'ambiguous')
  )
  DELETE FROM classification_review_groups review
  USING affected
  WHERE review.source_id = affected.source_id
    AND review.reference_type_id = affected.reference_type_id
    AND review.processor_version = affected.processor_version
    AND review.scope = affected.scope
    AND review.normalized_source_value = affected.normalized_source_value
    AND review.context_key = affected.context_key
    AND review.observation_status = affected.observation_status;

  WITH affected AS (
    SELECT DISTINCT
      item.source_id,
      type.id AS reference_type_id,
      item.processor_version,
      item.scope,
      item.normalized_source_value,
      item.context_key,
      item.observation_status
    FROM JSONB_TO_RECORDSET(keys) AS item(
      source_id BIGINT,
      type_code TEXT,
      processor_version TEXT,
      scope TEXT,
      normalized_source_value TEXT,
      context_key TEXT,
      observation_status TEXT
    )
    JOIN reference_types type ON type.code = item.type_code
    WHERE item.observation_status IN ('unresolved', 'ambiguous')
  ), observations AS MATERIALIZED (
    SELECT observation.*
    FROM source_reference_observations observation
    JOIN affected
      ON affected.source_id = observation.source_id
     AND affected.reference_type_id = observation.reference_type_id
     AND affected.processor_version = observation.processor_version
     AND affected.scope = observation.scope
     AND affected.normalized_source_value = observation.normalized_source_value
     AND affected.context_key = observation.context_key
     AND affected.observation_status = observation.status
    WHERE observation.active = TRUE
      AND observation.status IN ('unresolved', 'ambiguous')
  ), rule_resolutions AS MATERIALIZED (
    SELECT resolution.*
    FROM classification_review_rule_resolutions(COALESCE(
      (SELECT ARRAY_AGG(observation.id) FROM observations observation),
      ARRAY[]::BIGINT[]
    )) resolution
  ), classified AS (
    SELECT
      observation.*,
      mapping.id IS NOT NULL OR rule_resolution.rule_id IS NOT NULL AS waiting
    FROM observations observation
    LEFT JOIN source_reference_mappings mapping
      ON mapping.source_id = observation.source_id
     AND mapping.reference_type_id = observation.reference_type_id
     AND mapping.scope = observation.scope
     AND mapping.normalized_source_value = observation.normalized_source_value
     AND mapping.context_key = observation.context_key
     AND (mapping.status = 'ignored' OR EXISTS (
       SELECT 1 FROM reference_values value
       WHERE value.id = mapping.reference_value_id AND value.enabled = TRUE
     ))
    LEFT JOIN rule_resolutions rule_resolution
      ON rule_resolution.observation_id = observation.id
  ), grouped AS (
    SELECT
      source_id,
      reference_type_id,
      processor_version,
      scope,
      normalized_source_value,
      context_key,
      status AS observation_status,
      CASE WHEN COUNT(*) FILTER (WHERE NOT waiting) = 0
        THEN 'waiting_apply'
        ELSE status
      END AS review_status,
      (ARRAY_AGG(source_value ORDER BY last_seen_at DESC, id DESC))[1] AS source_value,
      (ARRAY_AGG(context ORDER BY last_seen_at DESC, id DESC))[1] AS context,
      (ARRAY_AGG(issue_reason ORDER BY last_seen_at DESC, id DESC))[1] AS issue_reason,
      COUNT(*)::INTEGER AS total_observation_count,
      COUNT(DISTINCT source_product_id)::INTEGER AS total_product_count,
      COUNT(*) FILTER (WHERE NOT waiting)::INTEGER AS needs_decision_observation_count,
      COUNT(DISTINCT source_product_id) FILTER (WHERE NOT waiting)::INTEGER AS needs_decision_product_count,
      COUNT(*) FILTER (WHERE waiting)::INTEGER AS waiting_observation_count,
      COUNT(DISTINCT source_product_id) FILTER (WHERE waiting)::INTEGER AS waiting_product_count,
      MIN(first_seen_at) AS first_seen_at,
      MAX(last_seen_at) AS last_seen_at
    FROM classified
    GROUP BY source_id, reference_type_id, processor_version, scope,
      normalized_source_value, context_key, status
  )
  INSERT INTO classification_review_groups (
    source_id, reference_type_id, processor_version, scope,
    normalized_source_value, context_key, observation_status, review_status,
    source_value, context, issue_reason,
    total_observation_count, total_product_count,
    needs_decision_observation_count, needs_decision_product_count,
    waiting_observation_count, waiting_product_count,
    first_seen_at, last_seen_at
  )
  SELECT
    source_id, reference_type_id, processor_version, scope,
    normalized_source_value, context_key, observation_status, review_status,
    source_value, context, issue_reason,
    total_observation_count, total_product_count,
    needs_decision_observation_count, needs_decision_product_count,
    waiting_observation_count, waiting_product_count,
    first_seen_at, last_seen_at
  FROM grouped;
END;
$$;

CREATE OR REPLACE FUNCTION classification_review_product_contributions(product_id BIGINT)
RETURNS TABLE (
  source_id BIGINT,
  reference_type_id BIGINT,
  type_code TEXT,
  processor_version TEXT,
  scope TEXT,
  normalized_source_value TEXT,
  context_key TEXT,
  observation_status TEXT,
  source_value TEXT,
  context JSONB,
  issue_reason TEXT,
  total_observation_count INTEGER,
  total_product_count INTEGER,
  needs_decision_observation_count INTEGER,
  needs_decision_product_count INTEGER,
  waiting_observation_count INTEGER,
  waiting_product_count INTEGER,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  WITH observations AS MATERIALIZED (
    SELECT observation.*
    FROM source_reference_observations observation
    WHERE observation.source_product_id = product_id
      AND observation.active = TRUE
      AND observation.status IN ('unresolved', 'ambiguous')
  ), rule_resolutions AS MATERIALIZED (
    SELECT resolution.*
    FROM classification_review_rule_resolutions(COALESCE(
      (SELECT ARRAY_AGG(observation.id) FROM observations observation),
      ARRAY[]::BIGINT[]
    )) resolution
  ), classified AS (
    SELECT
      observation.*,
      mapping.id IS NOT NULL OR rule_resolution.rule_id IS NOT NULL AS waiting
    FROM observations observation
    LEFT JOIN source_reference_mappings mapping
      ON mapping.source_id = observation.source_id
     AND mapping.reference_type_id = observation.reference_type_id
     AND mapping.scope = observation.scope
     AND mapping.normalized_source_value = observation.normalized_source_value
     AND mapping.context_key = observation.context_key
     AND (mapping.status = 'ignored' OR EXISTS (
       SELECT 1 FROM reference_values value
       WHERE value.id = mapping.reference_value_id AND value.enabled = TRUE
     ))
    LEFT JOIN rule_resolutions rule_resolution
      ON rule_resolution.observation_id = observation.id
  )
  SELECT
    classified.source_id,
    classified.reference_type_id,
    type.code AS type_code,
    classified.processor_version,
    classified.scope,
    classified.normalized_source_value,
    classified.context_key,
    classified.status AS observation_status,
    (ARRAY_AGG(classified.source_value ORDER BY classified.last_seen_at DESC, classified.id DESC))[1] AS source_value,
    (ARRAY_AGG(classified.context ORDER BY classified.last_seen_at DESC, classified.id DESC))[1] AS context,
    (ARRAY_AGG(classified.issue_reason ORDER BY classified.last_seen_at DESC, classified.id DESC))[1] AS issue_reason,
    COUNT(*)::INTEGER AS total_observation_count,
    1 AS total_product_count,
    COUNT(*) FILTER (WHERE NOT classified.waiting)::INTEGER AS needs_decision_observation_count,
    CASE WHEN BOOL_OR(NOT classified.waiting) THEN 1 ELSE 0 END AS needs_decision_product_count,
    COUNT(*) FILTER (WHERE classified.waiting)::INTEGER AS waiting_observation_count,
    CASE WHEN BOOL_OR(classified.waiting) THEN 1 ELSE 0 END AS waiting_product_count,
    MIN(classified.first_seen_at) AS first_seen_at,
    MAX(classified.last_seen_at) AS last_seen_at
  FROM classified
  JOIN reference_types type ON type.id = classified.reference_type_id
  GROUP BY classified.source_id, classified.reference_type_id, type.code,
    classified.processor_version, classified.scope, classified.normalized_source_value,
    classified.context_key, classified.status;
$$;

CREATE OR REPLACE FUNCTION apply_classification_review_product_contributions(
  previous_contributions JSONB,
  current_contributions JSONB
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  group_lock BIGINT;
  item RECORD;
  changed_rows INTEGER;
  remaining_observations INTEGER;
BEGIN
  FOR group_lock IN
    WITH contribution_keys AS (
      SELECT source_id, reference_type_id, processor_version, scope,
        normalized_source_value, context_key, observation_status
      FROM JSONB_TO_RECORDSET(COALESCE(previous_contributions, '[]'::JSONB)) AS previous(
        source_id BIGINT, reference_type_id BIGINT, processor_version TEXT, scope TEXT,
        normalized_source_value TEXT, context_key TEXT, observation_status TEXT
      )
      UNION
      SELECT source_id, reference_type_id, processor_version, scope,
        normalized_source_value, context_key, observation_status
      FROM JSONB_TO_RECORDSET(COALESCE(current_contributions, '[]'::JSONB)) AS current(
        source_id BIGINT, reference_type_id BIGINT, processor_version TEXT, scope TEXT,
        normalized_source_value TEXT, context_key TEXT, observation_status TEXT
      )
    )
    SELECT classification_review_group_lock_key(
      source_id, reference_type_id, processor_version, scope,
      normalized_source_value, context_key, observation_status
    )
    FROM contribution_keys
    ORDER BY 1
  LOOP
    PERFORM PG_ADVISORY_XACT_LOCK(group_lock);
  END LOOP;

  FOR item IN
    WITH previous AS (
      SELECT *
      FROM JSONB_TO_RECORDSET(COALESCE(previous_contributions, '[]'::JSONB)) AS contribution(
        source_id BIGINT, reference_type_id BIGINT, type_code TEXT,
        processor_version TEXT, scope TEXT, normalized_source_value TEXT,
        context_key TEXT, observation_status TEXT, source_value TEXT, context JSONB,
        issue_reason TEXT, total_observation_count INTEGER, total_product_count INTEGER,
        needs_decision_observation_count INTEGER, needs_decision_product_count INTEGER,
        waiting_observation_count INTEGER, waiting_product_count INTEGER,
        first_seen_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ
      )
    ), current AS (
      SELECT *
      FROM JSONB_TO_RECORDSET(COALESCE(current_contributions, '[]'::JSONB)) AS contribution(
        source_id BIGINT, reference_type_id BIGINT, type_code TEXT,
        processor_version TEXT, scope TEXT, normalized_source_value TEXT,
        context_key TEXT, observation_status TEXT, source_value TEXT, context JSONB,
        issue_reason TEXT, total_observation_count INTEGER, total_product_count INTEGER,
        needs_decision_observation_count INTEGER, needs_decision_product_count INTEGER,
        waiting_observation_count INTEGER, waiting_product_count INTEGER,
        first_seen_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ
      )
    )
    SELECT
      COALESCE(current.source_id, previous.source_id) AS source_id,
      COALESCE(current.reference_type_id, previous.reference_type_id) AS reference_type_id,
      COALESCE(current.processor_version, previous.processor_version) AS processor_version,
      COALESCE(current.scope, previous.scope) AS scope,
      COALESCE(current.normalized_source_value, previous.normalized_source_value) AS normalized_source_value,
      COALESCE(current.context_key, previous.context_key) AS context_key,
      COALESCE(current.observation_status, previous.observation_status) AS observation_status,
      COALESCE(current.source_value, previous.source_value) AS source_value,
      COALESCE(current.context, previous.context) AS context,
      COALESCE(current.issue_reason, previous.issue_reason) AS issue_reason,
      current.source_id IS NOT NULL AS has_current,
      current.first_seen_at AS current_first_seen_at,
      current.last_seen_at AS current_last_seen_at,
      COALESCE(current.total_observation_count, 0) - COALESCE(previous.total_observation_count, 0) AS total_observation_delta,
      COALESCE(current.total_product_count, 0) - COALESCE(previous.total_product_count, 0) AS total_product_delta,
      COALESCE(current.needs_decision_observation_count, 0) - COALESCE(previous.needs_decision_observation_count, 0) AS needs_observation_delta,
      COALESCE(current.needs_decision_product_count, 0) - COALESCE(previous.needs_decision_product_count, 0) AS needs_product_delta,
      COALESCE(current.waiting_observation_count, 0) - COALESCE(previous.waiting_observation_count, 0) AS waiting_observation_delta,
      COALESCE(current.waiting_product_count, 0) - COALESCE(previous.waiting_product_count, 0) AS waiting_product_delta
    FROM previous
    FULL JOIN current
      ON current.source_id = previous.source_id
     AND current.reference_type_id = previous.reference_type_id
     AND current.processor_version = previous.processor_version
     AND current.scope = previous.scope
     AND current.normalized_source_value = previous.normalized_source_value
     AND current.context_key = previous.context_key
     AND current.observation_status = previous.observation_status
  LOOP
    DELETE FROM classification_review_groups review
    WHERE review.source_id = item.source_id
      AND review.reference_type_id = item.reference_type_id
      AND review.processor_version = item.processor_version
      AND review.scope = item.scope
      AND review.normalized_source_value = item.normalized_source_value
      AND review.context_key = item.context_key
      AND review.observation_status = item.observation_status
      AND review.total_observation_count + item.total_observation_delta = 0;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows > 0 THEN
      CONTINUE;
    END IF;

    UPDATE classification_review_groups review
    SET total_observation_count = review.total_observation_count + item.total_observation_delta,
        total_product_count = review.total_product_count + item.total_product_delta,
        needs_decision_observation_count = review.needs_decision_observation_count + item.needs_observation_delta,
        needs_decision_product_count = review.needs_decision_product_count + item.needs_product_delta,
        waiting_observation_count = review.waiting_observation_count + item.waiting_observation_delta,
        waiting_product_count = review.waiting_product_count + item.waiting_product_delta,
        review_status = CASE
          WHEN review.needs_decision_observation_count + item.needs_observation_delta = 0 THEN 'waiting_apply'
          ELSE review.observation_status
        END,
        source_value = CASE WHEN item.has_current THEN item.source_value ELSE review.source_value END,
        context = CASE WHEN item.has_current THEN item.context ELSE review.context END,
        issue_reason = CASE WHEN item.has_current THEN item.issue_reason ELSE review.issue_reason END,
        first_seen_at = CASE WHEN item.has_current
          THEN LEAST(review.first_seen_at, item.current_first_seen_at)
          ELSE review.first_seen_at
        END,
        last_seen_at = CASE WHEN item.has_current
          THEN GREATEST(review.last_seen_at, item.current_last_seen_at)
          ELSE review.last_seen_at
        END,
        updated_at = NOW()
    WHERE review.source_id = item.source_id
      AND review.reference_type_id = item.reference_type_id
      AND review.processor_version = item.processor_version
      AND review.scope = item.scope
      AND review.normalized_source_value = item.normalized_source_value
      AND review.context_key = item.context_key
      AND review.observation_status = item.observation_status
    RETURNING review.total_observation_count INTO remaining_observations;

    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows = 0 THEN
      IF item.total_observation_delta <= 0 THEN
        RAISE EXCEPTION 'Classification review group delta cannot be applied to a missing group';
      END IF;
      INSERT INTO classification_review_groups (
        source_id, reference_type_id, processor_version, scope,
        normalized_source_value, context_key, observation_status, review_status,
        source_value, context, issue_reason,
        total_observation_count, total_product_count,
        needs_decision_observation_count, needs_decision_product_count,
        waiting_observation_count, waiting_product_count,
        first_seen_at, last_seen_at
      ) VALUES (
        item.source_id, item.reference_type_id, item.processor_version, item.scope,
        item.normalized_source_value, item.context_key, item.observation_status,
        CASE WHEN item.needs_observation_delta = 0 THEN 'waiting_apply' ELSE item.observation_status END,
        item.source_value, item.context, item.issue_reason,
        item.total_observation_delta, item.total_product_delta,
        item.needs_observation_delta, item.needs_product_delta,
        item.waiting_observation_delta, item.waiting_product_delta,
        item.current_first_seen_at, item.current_last_seen_at
      );
    END IF;
  END LOOP;
END;
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
  FROM source_reference_observations observation
  JOIN source_reference_rules rule
    ON rule.reference_type_id = observation.reference_type_id
   AND (rule.source_id IS NULL OR rule.source_id = observation.source_id)
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

CREATE OR REPLACE FUNCTION rebuild_classification_review_groups()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  all_keys JSONB;
BEGIN
  TRUNCATE classification_review_groups;
  SELECT COALESCE(JSONB_AGG(TO_JSONB(key_row)), '[]'::JSONB)
  INTO all_keys
  FROM (
    SELECT DISTINCT
      observation.source_id,
      type.code AS type_code,
      observation.processor_version,
      observation.scope,
      observation.normalized_source_value,
      observation.context_key,
      observation.status AS observation_status
    FROM source_reference_observations observation
    JOIN reference_types type ON type.id = observation.reference_type_id
    WHERE observation.active = TRUE
      AND observation.status IN ('unresolved', 'ambiguous')
  ) key_row;
  -- The full rebuild already holds table locks. Taking one transaction-level
  -- advisory lock per group would exhaust PostgreSQL's shared lock table on a
  -- production-sized catalog.
  PERFORM refresh_classification_review_groups(all_keys, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION rebuild_classification_review_read_model()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  LOCK TABLE source_reference_observations IN SHARE MODE;
  LOCK TABLE source_reference_mappings IN SHARE MODE;
  LOCK TABLE source_reference_rules IN SHARE MODE;
  LOCK TABLE reference_values IN SHARE MODE;
  PERFORM rebuild_classification_review_rule_coverage();
  PERFORM rebuild_classification_review_groups();
END;
$$;

SELECT rebuild_classification_review_read_model();

DROP INDEX IF EXISTS source_reference_observations_review_covering_idx;
DROP INDEX IF EXISTS source_reference_observations_rule_candidates_idx;

CREATE INDEX source_reference_observations_review_group_detail_idx
  ON source_reference_observations (
    source_id,
    reference_type_id,
    processor_version,
    status,
    normalized_source_value,
    scope,
    context_key,
    last_seen_at DESC,
    id DESC
  )
  INCLUDE (source_product_id, first_seen_at)
  WHERE active = TRUE AND status IN ('unresolved', 'ambiguous');

CREATE INDEX source_reference_observations_rule_candidates_idx
  ON source_reference_observations (
    source_id,
    reference_type_id,
    processor_version,
    normalized_source_value,
    source_product_id
  )
  WHERE active = TRUE;
