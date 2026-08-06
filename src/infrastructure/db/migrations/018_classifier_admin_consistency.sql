ALTER TABLE target_classification_projection_history
  DROP CONSTRAINT target_classification_projection_history_action_check;

ALTER TABLE target_classification_projection_history
  ADD CONSTRAINT target_classification_projection_history_action_check
  CHECK (action IN ('create', 'update', 'reactivate', 'deactivate'));

CREATE INDEX IF NOT EXISTS source_reference_observations_reference_active_idx
  ON source_reference_observations (resolved_reference_value_id, source_product_id)
  WHERE active = TRUE AND resolved_reference_value_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_reference_observations_rule_active_idx
  ON source_reference_observations (rule_id, source_product_id)
  WHERE active = TRUE AND rule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS internal_products_status_source_product_idx
  ON internal_products (status, source_product_id);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS source_products_source_key_trgm_idx
  ON source_products USING GIN (source_key GIN_TRGM_OPS);

CREATE INDEX IF NOT EXISTS source_products_external_id_trgm_idx
  ON source_products USING GIN (external_id GIN_TRGM_OPS)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_products_discovery_title_trgm_idx
  ON source_products USING GIN ((COALESCE(discovery_metadata->>'title', '')) GIN_TRGM_OPS);

CREATE INDEX IF NOT EXISTS internal_products_title_trgm_idx
  ON internal_products USING GIN ((COALESCE(data->>'title', '')) GIN_TRGM_OPS);
