DROP INDEX IF EXISTS internal_products_preflight_candidates_idx;

CREATE INDEX internal_products_preflight_candidates_idx
  ON internal_products (updated_at DESC, id DESC)
  INCLUDE (source_product_id, content_hash)
  WHERE status IN ('classified', 'classification_pending')
    AND data->'classification'->>'status' IN ('complete', 'partial');
