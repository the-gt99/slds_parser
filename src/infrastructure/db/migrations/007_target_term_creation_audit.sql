CREATE TABLE target_term_creation_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  source_id BIGINT NOT NULL REFERENCES sources(id),
  observation_id BIGINT REFERENCES source_reference_observations(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  requested_name TEXT NOT NULL,
  requested_slug TEXT,
  requested_parent_external_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  external_id TEXT,
  actor TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CHECK (
    (status = 'running' AND external_id IS NULL AND error IS NULL AND finished_at IS NULL)
    OR (status = 'completed' AND external_id IS NOT NULL AND error IS NULL AND finished_at IS NOT NULL)
    OR (status = 'failed' AND error IS NOT NULL AND finished_at IS NOT NULL)
  )
);

CREATE INDEX target_term_creation_history_target_created_idx
  ON target_term_creation_history (target_id, created_at DESC);

CREATE INDEX target_term_creation_history_source_created_idx
  ON target_term_creation_history (source_id, created_at DESC);
