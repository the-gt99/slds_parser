CREATE INDEX target_dictionary_values_exact_name_idx
  ON target_dictionary_values (
    target_id,
    entity_type,
    LOWER(NORMALIZE(BTRIM(name), NFKC)),
    id
  )
  INCLUDE (external_id, slug, taxonomy)
  WHERE active = TRUE;

CREATE INDEX classification_review_groups_exact_match_idx
  ON classification_review_groups (
    reference_type_id,
    normalized_source_value,
    source_id,
    processor_version,
    id
  )
  INCLUDE (
    review_status,
    needs_decision_observation_count,
    needs_decision_product_count,
    last_seen_at
  )
  WHERE review_status IN ('unresolved', 'ambiguous')
    AND needs_decision_observation_count > 0;
