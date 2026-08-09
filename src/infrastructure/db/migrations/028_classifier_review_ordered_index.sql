DROP INDEX IF EXISTS source_reference_observations_review_covering_idx;

CREATE INDEX source_reference_observations_review_covering_idx
  ON source_reference_observations (
    source_id,
    reference_type_id,
    status,
    normalized_source_value,
    scope,
    context_key,
    last_seen_at DESC,
    id DESC
  )
  INCLUDE (source_product_id, first_seen_at)
  WHERE active = TRUE AND status IN ('unresolved', 'ambiguous');
