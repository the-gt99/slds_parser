ALTER TABLE rules_v2
  ALTER COLUMN source_id DROP NOT NULL,
  ALTER COLUMN target_id DROP NOT NULL;

ALTER TABLE rules_v2
  DROP CONSTRAINT rules_v2_origin_kind_check;

ALTER TABLE rules_v2
  ADD CONSTRAINT rules_v2_origin_kind_check CHECK (
    origin_kind IN (
      'native',
      'exact_mapping',
      'classification_rule',
      'target_mapping',
      'classification_projection',
      'reference_projection',
      'target_assignment_rule'
    )
  );

ALTER TABLE rules_v2
  DROP CONSTRAINT rules_v2_selector_operator_check;

ALTER TABLE rules_v2
  ADD CONSTRAINT rules_v2_selector_operator_check CHECK (
    selector_operator IN ('equals', 'one_of', 'contains_phrase', 'contains', 'all_words', 'regex', 'absent')
  );

ALTER TABLE rules_v2
  ADD COLUMN origin_revision BIGINT NOT NULL DEFAULT 1 CHECK (origin_revision > 0),
  ADD COLUMN origin_payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (JSONB_TYPEOF(origin_payload) = 'object');

DROP INDEX rules_v2_origin_idx;

CREATE UNIQUE INDEX rules_v2_origin_idx
  ON rules_v2 (origin_kind, origin_id)
  WHERE origin_id IS NOT NULL;

CREATE TABLE rules_v2_import_runs (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  counts JSONB NOT NULL CHECK (JSONB_TYPEOF(counts) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX rules_v2_import_runs_created_idx
  ON rules_v2_import_runs (created_at DESC, id DESC);
