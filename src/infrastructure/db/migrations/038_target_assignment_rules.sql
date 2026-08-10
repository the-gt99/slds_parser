CREATE TABLE target_assignment_rules (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  group_code TEXT NOT NULL CHECK (group_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  priority INTEGER NOT NULL DEFAULT 100,
  conditions JSONB NOT NULL CHECK (JSONB_TYPEOF(conditions) = 'array' AND JSONB_ARRAY_LENGTH(conditions) > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX target_assignment_rules_runtime_idx
  ON target_assignment_rules (target_id, enabled, group_code, priority DESC, id);

CREATE TABLE target_assignment_rule_actions (
  id BIGSERIAL PRIMARY KEY,
  rule_id BIGINT NOT NULL REFERENCES target_assignment_rules(id) ON DELETE CASCADE,
  target_scope TEXT NOT NULL CHECK (BTRIM(target_scope) <> ''),
  dictionary_value_id BIGINT NOT NULL REFERENCES target_dictionary_values(id),
  mode TEXT NOT NULL CHECK (mode IN ('add', 'replace')),
  UNIQUE (rule_id, target_scope, dictionary_value_id)
);

CREATE INDEX target_assignment_rule_actions_rule_idx
  ON target_assignment_rule_actions (rule_id, id);

CREATE TABLE target_assignment_rule_history (
  id BIGSERIAL PRIMARY KEY,
  rule_id BIGINT NOT NULL REFERENCES target_assignment_rules(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  previous_value JSONB,
  new_value JSONB,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX target_assignment_rule_history_rule_idx
  ON target_assignment_rule_history (rule_id, created_at DESC, id DESC);
