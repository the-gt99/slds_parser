CREATE INDEX IF NOT EXISTS source_reference_observations_mapping_config_idx
  ON source_reference_observations (mapping_id, last_seen_at DESC, id DESC)
  INCLUDE (source_product_id, source_id)
  WHERE active = TRUE AND mapping_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_reference_observations_rule_config_idx
  ON source_reference_observations (rule_id, last_seen_at DESC, id DESC)
  INCLUDE (source_product_id, source_id)
  WHERE active = TRUE AND rule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_reference_observations_reference_config_idx
  ON source_reference_observations (resolved_reference_value_id, last_seen_at DESC, id DESC)
  INCLUDE (source_product_id, source_id)
  WHERE active = TRUE AND resolved_reference_value_id IS NOT NULL;

DROP INDEX IF EXISTS source_reference_observations_mapping_idx;
DROP INDEX IF EXISTS source_reference_observations_rule_idx;
