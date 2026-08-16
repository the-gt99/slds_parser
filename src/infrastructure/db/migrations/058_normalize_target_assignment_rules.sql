CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE target_assignment_match_sets (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_id, code)
);

CREATE TABLE target_assignment_match_set_values (
  id BIGSERIAL PRIMARY KEY,
  match_set_id BIGINT NOT NULL REFERENCES target_assignment_match_sets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  value TEXT NOT NULL CHECK (BTRIM(value) <> ''),
  normalized_value TEXT NOT NULL CHECK (BTRIM(normalized_value) <> ''),
  UNIQUE (match_set_id, normalized_value),
  UNIQUE (match_set_id, position)
);

CREATE INDEX target_assignment_match_set_values_lookup_idx
  ON target_assignment_match_set_values (match_set_id, normalized_value);

CREATE TABLE target_assignment_match_set_history (
  id BIGSERIAL PRIMARY KEY,
  match_set_id BIGINT NOT NULL REFERENCES target_assignment_match_sets(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('create', 'update')),
  previous_value JSONB,
  new_value JSONB NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX target_assignment_match_set_history_idx
  ON target_assignment_match_set_history (match_set_id, created_at DESC, id DESC);

CREATE TABLE target_assignment_rule_condition_groups (
  id BIGSERIAL PRIMARY KEY,
  rule_id BIGINT NOT NULL REFERENCES target_assignment_rules(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE (rule_id, position)
);

CREATE TABLE target_assignment_rule_conditions (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES target_assignment_rule_condition_groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  field TEXT NOT NULL CHECK (BTRIM(field) <> ''),
  operator TEXT NOT NULL CHECK (operator IN ('equals', 'one_of', 'contains_phrase')),
  match_set_id BIGINT REFERENCES target_assignment_match_sets(id),
  UNIQUE (group_id, position)
);

CREATE INDEX target_assignment_rule_conditions_set_idx
  ON target_assignment_rule_conditions (match_set_id)
  WHERE match_set_id IS NOT NULL;

CREATE TABLE target_assignment_rule_condition_values (
  id BIGSERIAL PRIMARY KEY,
  condition_id BIGINT NOT NULL REFERENCES target_assignment_rule_conditions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  value TEXT NOT NULL CHECK (BTRIM(value) <> ''),
  normalized_value TEXT NOT NULL CHECK (BTRIM(normalized_value) <> ''),
  UNIQUE (condition_id, normalized_value),
  UNIQUE (condition_id, position)
);

WITH expanded AS (
  SELECT rule.id AS rule_id, item.condition, (item.ordinality - 1)::INTEGER AS position
  FROM target_assignment_rules rule
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(rule.conditions) WITH ORDINALITY item(condition, ordinality)
)
INSERT INTO target_assignment_rule_condition_groups (rule_id, position)
SELECT rule_id, position FROM expanded;

WITH expanded AS (
  SELECT rule.id AS rule_id, item.condition, (item.ordinality - 1)::INTEGER AS position
  FROM target_assignment_rules rule
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(rule.conditions) WITH ORDINALITY item(condition, ordinality)
)
INSERT INTO target_assignment_rule_conditions (group_id, position, field, operator)
SELECT group_row.id, 0, expanded.condition->>'field', expanded.condition->>'operator'
FROM expanded
JOIN target_assignment_rule_condition_groups group_row
  ON group_row.rule_id = expanded.rule_id AND group_row.position = expanded.position;

WITH expanded AS (
  SELECT rule.id AS rule_id, item.condition, (item.ordinality - 1)::INTEGER AS group_position
  FROM target_assignment_rules rule
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(rule.conditions) WITH ORDINALITY item(condition, ordinality)
), condition_rows AS (
  SELECT condition_row.id AS condition_id, expanded.condition
  FROM expanded
  JOIN target_assignment_rule_condition_groups group_row
    ON group_row.rule_id = expanded.rule_id AND group_row.position = expanded.group_position
  JOIN target_assignment_rule_conditions condition_row
    ON condition_row.group_id = group_row.id AND condition_row.position = 0
)
INSERT INTO target_assignment_rule_condition_values (condition_id, position, value, normalized_value)
SELECT condition_rows.condition_id, (entry.ordinality - 1)::INTEGER, entry.value, LOWER(BTRIM(entry.value))
FROM condition_rows
CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(condition_rows.condition->'values') WITH ORDINALITY entry(value, ordinality);

ALTER TABLE target_assignment_rules DROP COLUMN conditions;

ALTER TABLE classification_candidates
  ADD COLUMN phrase_search_value TEXT GENERATED ALWAYS AS (
    ' ' || BTRIM(REGEXP_REPLACE(LOWER(normalized_source_value), '[^[:alnum:]]+', ' ', 'g')) || ' '
  ) STORED;

CREATE INDEX classification_candidates_phrase_search_idx
  ON classification_candidates USING GIN (phrase_search_value gin_trgm_ops);
