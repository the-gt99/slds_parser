CREATE TABLE rules_v2_workbench_state (
  source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  target_id BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  rules_revision TEXT NOT NULL,
  cursor_id BIGINT,
  sweep_max_id BIGINT,
  floor_id BIGINT NOT NULL DEFAULT 0,
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, target_id)
);

CREATE TABLE rules_v2_workbench_items (
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  target_id BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  rules_revision TEXT NOT NULL,
  product_updated_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('ready', 'incomplete', 'conflict')),
  issue_count INTEGER NOT NULL,
  issue_codes TEXT[] NOT NULL DEFAULT '{}',
  search_text TEXT NOT NULL,
  title TEXT NOT NULL,
  source_external_id TEXT,
  sku TEXT,
  result JSONB NOT NULL,
  blockers JSONB NOT NULL,
  conflicts JSONB NOT NULL,
  candidates JSONB NOT NULL,
  trace JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_product_id, target_id)
);

CREATE INDEX rules_v2_workbench_filter_idx ON rules_v2_workbench_items
  (source_id, target_id, rules_revision, status, source_product_id DESC)
  WHERE product_updated_at IS NOT NULL;
CREATE INDEX rules_v2_workbench_issues_idx ON rules_v2_workbench_items
  (source_id, target_id, rules_revision, issue_count DESC, source_product_id DESC)
  WHERE product_updated_at IS NOT NULL;
CREATE INDEX rules_v2_workbench_latest_idx ON rules_v2_workbench_items
  (source_id, target_id, rules_revision, product_updated_at DESC, source_product_id DESC)
  WHERE product_updated_at IS NOT NULL;
CREATE INDEX rules_v2_workbench_search_idx ON rules_v2_workbench_items
  USING GIN (search_text gin_trgm_ops);
CREATE INDEX rules_v2_workbench_codes_idx ON rules_v2_workbench_items
  USING GIN (issue_codes);

CREATE FUNCTION invalidate_rules_v2_workbench_product() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE rules_v2_workbench_items
  SET product_updated_at = NULL
  WHERE source_product_id = NEW.source_product_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER internal_products_invalidate_rules_v2_workbench
AFTER INSERT OR UPDATE OF data, content_hash ON internal_products
FOR EACH ROW EXECUTE FUNCTION invalidate_rules_v2_workbench_product();
