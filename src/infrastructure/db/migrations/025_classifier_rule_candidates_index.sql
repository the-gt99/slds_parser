CREATE INDEX IF NOT EXISTS source_reference_observations_rule_candidates_idx
  ON source_reference_observations (
    source_id,
    reference_type_id,
    normalized_source_value,
    source_product_id
  )
  WHERE active = TRUE;
