CREATE INDEX IF NOT EXISTS source_products_external_id_idx
  ON source_products (external_id)
  WHERE external_id IS NOT NULL;
