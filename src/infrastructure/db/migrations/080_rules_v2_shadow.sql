CREATE TABLE rules_v2 (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  target_id BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  group_code TEXT NOT NULL CHECK (group_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'shadow', 'disabled')),
  condition_groups JSONB NOT NULL CHECK (
    JSONB_TYPEOF(condition_groups) = 'array' AND JSONB_ARRAY_LENGTH(condition_groups) > 0
  ),
  actions JSONB NOT NULL CHECK (
    JSONB_TYPEOF(actions) = 'array' AND JSONB_ARRAY_LENGTH(actions) > 0
  ),
  selector_field TEXT NOT NULL,
  selector_operator TEXT NOT NULL CHECK (selector_operator IN ('equals', 'one_of', 'contains_phrase', 'regex', 'absent')),
  selector_values_normalized TEXT[] NOT NULL DEFAULT '{}',
  origin_kind TEXT NOT NULL DEFAULT 'native' CHECK (
    origin_kind IN ('native', 'exact_mapping', 'classification_rule', 'target_mapping', 'projection', 'target_assignment_rule')
  ),
  origin_id BIGINT,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX rules_v2_origin_idx
  ON rules_v2 (origin_kind, origin_id, target_id)
  WHERE origin_id IS NOT NULL;

CREATE INDEX rules_v2_list_idx
  ON rules_v2 (target_id, status, priority DESC, id DESC);

CREATE INDEX rules_v2_source_selector_idx
  ON rules_v2 (source_id, status, selector_field, selector_operator);

CREATE INDEX rules_v2_selector_values_idx
  ON rules_v2 USING GIN (selector_values_normalized);

CREATE TABLE rules_v2_history (
  id BIGSERIAL PRIMARY KEY,
  rule_id BIGINT NOT NULL REFERENCES rules_v2(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'status')),
  previous_value JSONB,
  new_value JSONB NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX rules_v2_history_idx
  ON rules_v2_history (rule_id, created_at DESC, id DESC);
