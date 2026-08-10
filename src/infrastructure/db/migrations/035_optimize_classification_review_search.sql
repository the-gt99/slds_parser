CREATE INDEX classification_review_groups_source_value_trgm_idx
  ON classification_review_groups USING GIN (source_value GIN_TRGM_OPS);

CREATE INDEX classification_review_groups_source_value_prefix_idx
  ON classification_review_groups (LOWER(source_value) TEXT_PATTERN_OPS);
