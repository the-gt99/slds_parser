CREATE TABLE target_dictionary_values (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  entity_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT,
  parent_external_id TEXT,
  taxonomy TEXT,
  attribute_code TEXT,
  remote_updated_at TIMESTAMPTZ,
  sync_cursor TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_id, entity_type, external_id)
);

CREATE INDEX target_dictionary_values_search_idx
  ON target_dictionary_values (target_id, entity_type, active, name);

ALTER TABLE target_value_mappings
  ADD COLUMN dictionary_value_id BIGINT REFERENCES target_dictionary_values(id),
  ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE INDEX target_value_mappings_dictionary_value_idx
  ON target_value_mappings (dictionary_value_id)
  WHERE dictionary_value_id IS NOT NULL;

CREATE TABLE target_value_mapping_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mapping_id BIGINT NOT NULL REFERENCES target_value_mappings(id),
  action TEXT NOT NULL,
  previous_value JSONB,
  new_value JSONB NOT NULL,
  actor TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX target_value_mapping_history_mapping_idx
  ON target_value_mapping_history (mapping_id, created_at DESC);
