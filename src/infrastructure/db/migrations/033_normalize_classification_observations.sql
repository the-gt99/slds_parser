CREATE EXTENSION IF NOT EXISTS pgcrypto;

LOCK TABLE source_reference_observations IN SHARE MODE;

CREATE TABLE classification_candidates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES sources(id),
  reference_type_id BIGINT NOT NULL REFERENCES reference_types(id),
  scope TEXT NOT NULL,
  normalized_source_value TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::JSONB,
  context_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (
    source_id,
    reference_type_id,
    scope,
    normalized_source_value,
    context_key
  )
);

CREATE INDEX classification_candidates_value_idx
  ON classification_candidates (
    source_id,
    reference_type_id,
    normalized_source_value,
    id
  );

CREATE TABLE source_product_classification_evidence (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  evidence_hash TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (evidence_hash = ENCODE(DIGEST(evidence::TEXT, 'sha256'), 'hex')),
  UNIQUE (source_product_id, evidence_hash)
);

CREATE TABLE source_product_classification_states (
  source_product_id BIGINT PRIMARY KEY REFERENCES source_products(id) ON DELETE CASCADE,
  processor_version TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  classification_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM source_reference_observations observation
    GROUP BY observation.source_id, observation.reference_type_id,
      observation.scope, observation.normalized_source_value, observation.context_key
    HAVING COUNT(DISTINCT observation.context) > 1
  ) THEN
    RAISE EXCEPTION 'Classification candidate context_key points to different contexts';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        observation.source_product_id,
        ENCODE(DIGEST(observation.evidence::TEXT, 'sha256'), 'hex') AS evidence_hash,
        observation.evidence
      FROM source_reference_observations observation
    ) evidence
    GROUP BY evidence.source_product_id, evidence.evidence_hash
    HAVING COUNT(DISTINCT evidence.evidence) > 1
  ) THEN
    RAISE EXCEPTION 'Classification evidence hash collision detected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM source_reference_observations observation
    WHERE observation.active = TRUE
    GROUP BY observation.source_product_id
    HAVING COUNT(DISTINCT (
      observation.processor_version,
      observation.classifier_version,
      observation.classification_fingerprint
    )) > 1
  ) THEN
    RAISE EXCEPTION 'Active classification observations have inconsistent product state';
  END IF;
END;
$$;

INSERT INTO classification_candidates (
  source_id,
  reference_type_id,
  scope,
  normalized_source_value,
  context,
  context_key,
  created_at,
  updated_at
)
SELECT DISTINCT ON (
  observation.source_id,
  observation.reference_type_id,
  observation.scope,
  observation.normalized_source_value,
  observation.context_key
)
  observation.source_id,
  observation.reference_type_id,
  observation.scope,
  observation.normalized_source_value,
  observation.context,
  observation.context_key,
  observation.created_at,
  observation.updated_at
FROM source_reference_observations observation
ORDER BY
  observation.source_id,
  observation.reference_type_id,
  observation.scope,
  observation.normalized_source_value,
  observation.context_key,
  observation.last_seen_at DESC,
  observation.id DESC;

INSERT INTO source_product_classification_evidence (
  source_product_id,
  evidence_hash,
  evidence,
  created_at,
  updated_at
)
SELECT DISTINCT ON (prepared.source_product_id, prepared.evidence_hash)
  prepared.source_product_id,
  prepared.evidence_hash,
  prepared.evidence,
  prepared.created_at,
  prepared.updated_at
FROM (
  SELECT
    observation.source_product_id,
    ENCODE(DIGEST(observation.evidence::TEXT, 'sha256'), 'hex') AS evidence_hash,
    observation.evidence,
    observation.created_at,
    observation.updated_at,
    observation.last_seen_at,
    observation.id
  FROM source_reference_observations observation
) prepared
ORDER BY
  prepared.source_product_id,
  prepared.evidence_hash,
  prepared.last_seen_at DESC,
  prepared.id DESC;

INSERT INTO source_product_classification_states (
  source_product_id,
  processor_version,
  classifier_version,
  classification_fingerprint,
  created_at,
  updated_at
)
SELECT DISTINCT ON (observation.source_product_id)
  observation.source_product_id,
  observation.processor_version,
  observation.classifier_version,
  observation.classification_fingerprint,
  observation.created_at,
  observation.updated_at
FROM source_reference_observations observation
ORDER BY
  observation.source_product_id,
  observation.active DESC,
  observation.updated_at DESC,
  observation.id DESC;

CREATE TABLE source_product_classification_links (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  candidate_key TEXT NOT NULL,
  candidate_id BIGINT NOT NULL REFERENCES classification_candidates(id),
  evidence_id BIGINT NOT NULL REFERENCES source_product_classification_evidence(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('product', 'variant')),
  subject_key TEXT NOT NULL DEFAULT '',
  source_value TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('resolved', 'ignored', 'unresolved', 'ambiguous')),
  issue_reason TEXT,
  resolved_reference_value_id BIGINT REFERENCES reference_values(id),
  mapping_id BIGINT REFERENCES source_reference_mappings(id),
  rule_id BIGINT REFERENCES source_reference_rules(id),
  resolution_revision BIGINT,
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

INSERT INTO source_product_classification_links (
  id,
  source_product_id,
  candidate_key,
  candidate_id,
  evidence_id,
  subject_kind,
  subject_key,
  source_value,
  status,
  issue_reason,
  resolved_reference_value_id,
  mapping_id,
  rule_id,
  resolution_revision,
  active,
  first_seen_at,
  last_seen_at,
  created_at,
  updated_at
)
SELECT
  observation.id,
  observation.source_product_id,
  observation.candidate_key,
  candidate.id,
  evidence.id,
  observation.subject_kind,
  observation.subject_key,
  observation.source_value,
  observation.status,
  observation.issue_reason,
  observation.resolved_reference_value_id,
  observation.mapping_id,
  observation.rule_id,
  observation.resolution_revision,
  observation.active,
  observation.first_seen_at,
  observation.last_seen_at,
  observation.created_at,
  observation.updated_at
FROM source_reference_observations observation
JOIN classification_candidates candidate
  ON candidate.source_id = observation.source_id
 AND candidate.reference_type_id = observation.reference_type_id
 AND candidate.scope = observation.scope
 AND candidate.normalized_source_value = observation.normalized_source_value
 AND candidate.context_key = observation.context_key
JOIN source_product_classification_evidence evidence
  ON evidence.source_product_id = observation.source_product_id
 AND evidence.evidence_hash = ENCODE(DIGEST(observation.evidence::TEXT, 'sha256'), 'hex')
 AND evidence.evidence = observation.evidence;

DO $$
DECLARE
  previous_count BIGINT;
  normalized_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO previous_count FROM source_reference_observations;
  SELECT COUNT(*) INTO normalized_count FROM source_product_classification_links;
  IF previous_count <> normalized_count THEN
    RAISE EXCEPTION 'Classification observation migration lost rows: % <> %', previous_count, normalized_count;
  END IF;
END;
$$;

SELECT SETVAL(
  PG_GET_SERIAL_SEQUENCE('source_product_classification_links', 'id'),
  COALESCE((SELECT MAX(id) FROM source_product_classification_links), 1),
  EXISTS (SELECT 1 FROM source_product_classification_links)
);

CREATE INDEX source_product_classification_links_candidate_idx
  ON source_product_classification_links (candidate_id, source_product_id);

CREATE INDEX source_product_classification_links_evidence_idx
  ON source_product_classification_links (evidence_id);

CREATE INDEX source_product_classification_links_review_idx
  ON source_product_classification_links (
    candidate_id,
    status,
    last_seen_at DESC,
    id DESC
  )
  INCLUDE (source_product_id, first_seen_at)
  WHERE active = TRUE AND status IN ('unresolved', 'ambiguous');

CREATE INDEX source_product_classification_links_inactive_retention_idx
  ON source_product_classification_links (updated_at, id)
  WHERE active = FALSE;

CREATE INDEX source_product_classification_links_mapping_config_idx
  ON source_product_classification_links (mapping_id, last_seen_at DESC, id DESC)
  INCLUDE (source_product_id)
  WHERE active = TRUE AND mapping_id IS NOT NULL;

CREATE INDEX source_product_classification_links_rule_config_idx
  ON source_product_classification_links (rule_id, last_seen_at DESC, id DESC)
  INCLUDE (source_product_id)
  WHERE active = TRUE AND rule_id IS NOT NULL;

CREATE INDEX source_product_classification_links_reference_config_idx
  ON source_product_classification_links (resolved_reference_value_id, last_seen_at DESC, id DESC)
  INCLUDE (source_product_id)
  WHERE active = TRUE AND resolved_reference_value_id IS NOT NULL;

ALTER TABLE classification_review_rule_coverage
  DROP CONSTRAINT classification_review_rule_coverage_observation_id_fkey,
  ADD CONSTRAINT classification_review_rule_coverage_observation_id_fkey
    FOREIGN KEY (observation_id)
    REFERENCES source_product_classification_links(id)
    ON DELETE CASCADE;

ALTER TABLE target_term_creation_history
  DROP CONSTRAINT target_term_creation_history_observation_id_fkey,
  ADD CONSTRAINT target_term_creation_history_observation_id_fkey
    FOREIGN KEY (observation_id)
    REFERENCES source_product_classification_links(id)
    ON DELETE SET NULL;

DROP TABLE source_reference_observations;

CREATE VIEW source_reference_observations AS
SELECT
  link.id,
  candidate.source_id,
  link.source_product_id,
  link.candidate_key,
  candidate.reference_type_id,
  candidate.scope,
  link.subject_kind,
  link.subject_key,
  link.source_value,
  candidate.normalized_source_value,
  candidate.context,
  candidate.context_key,
  evidence.evidence,
  link.status,
  link.issue_reason,
  link.resolved_reference_value_id,
  link.mapping_id,
  link.rule_id,
  link.resolution_revision,
  state.processor_version,
  state.classifier_version,
  state.classification_fingerprint,
  link.active,
  link.first_seen_at,
  link.last_seen_at,
  link.created_at,
  link.updated_at
FROM source_product_classification_links link
JOIN classification_candidates candidate ON candidate.id = link.candidate_id
JOIN source_product_classification_evidence evidence ON evidence.id = link.evidence_id
JOIN source_product_classification_states state ON state.source_product_id = link.source_product_id;

CREATE OR REPLACE FUNCTION rebuild_classification_review_read_model()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  LOCK TABLE source_product_classification_links IN SHARE MODE;
  LOCK TABLE classification_candidates IN SHARE MODE;
  LOCK TABLE source_product_classification_evidence IN SHARE MODE;
  LOCK TABLE source_product_classification_states IN SHARE MODE;
  LOCK TABLE source_reference_mappings IN SHARE MODE;
  LOCK TABLE source_reference_rules IN SHARE MODE;
  LOCK TABLE reference_values IN SHARE MODE;
  PERFORM rebuild_classification_review_rule_coverage();
  PERFORM rebuild_classification_review_groups();
END;
$$;

COMMENT ON TABLE classification_candidates IS
  'Unique source classification values and their decision context.';

COMMENT ON TABLE source_product_classification_evidence IS
  'Candidate evidence payloads deduplicated within one source product.';

COMMENT ON TABLE source_product_classification_states IS
  'Processor and classifier state stored once per source product.';

COMMENT ON TABLE source_product_classification_links IS
  'Per-product classification state linked to shared candidates and evidence.';
