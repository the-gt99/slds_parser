CREATE INDEX IF NOT EXISTS source_reference_observations_review_group_idx
  ON source_reference_observations (
    source_id,
    reference_type_id,
    status,
    normalized_source_value,
    scope,
    context_key,
    last_seen_at DESC,
    id
  )
  WHERE active = TRUE AND status IN ('unresolved', 'ambiguous');
