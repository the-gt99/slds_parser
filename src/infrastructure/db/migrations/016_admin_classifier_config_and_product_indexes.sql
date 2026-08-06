CREATE INDEX IF NOT EXISTS source_products_updated_id_idx
  ON source_products (updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS source_products_source_updated_id_idx
  ON source_products (source_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS source_product_parts_product_fetched_idx
  ON source_product_parts (source_product_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS target_product_snapshots_source_product_idx
  ON target_product_snapshots (source_product_id);

CREATE INDEX IF NOT EXISTS jobs_active_export_product_target_idx
  ON jobs ((payload->>'internalProductId'), (payload->>'targetId'), updated_at DESC, id DESC)
  WHERE job_type = 'export_product' AND status IN ('pending', 'running', 'retry');

CREATE INDEX IF NOT EXISTS source_reference_mappings_admin_list_idx
  ON source_reference_mappings (updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS source_reference_rules_admin_list_idx
  ON source_reference_rules (updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS target_value_mappings_admin_list_idx
  ON target_value_mappings (updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS target_classification_projections_admin_list_idx
  ON target_classification_projections (updated_at DESC, id DESC);
