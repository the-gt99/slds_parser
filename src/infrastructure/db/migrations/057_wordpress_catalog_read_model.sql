CREATE OR REPLACE FUNCTION wordpress_catalog_audit_change_flags(result JSONB)
RETURNS TEXT[]
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT COALESCE(ARRAY(
    SELECT DISTINCT flag
    FROM (
      SELECT 'field:' || (field_item.value->>'field') AS flag
      FROM JSONB_ARRAY_ELEMENTS(COALESCE(result->'fields', '[]'::JSONB)) AS field_item(value)
      WHERE field_item.value->>'changed' = 'true'

      UNION ALL

      SELECT 'taxonomy:' || (taxonomy_item.value->>'taxonomy')
      FROM JSONB_ARRAY_ELEMENTS(COALESCE(result->'taxonomies', '[]'::JSONB)) AS taxonomy_item(value)
      WHERE taxonomy_item.value->>'changed' = 'true'

      UNION ALL

      SELECT 'taxonomy_added:' || (taxonomy_item.value->>'taxonomy')
      FROM JSONB_ARRAY_ELEMENTS(COALESCE(result->'taxonomies', '[]'::JSONB)) AS taxonomy_item(value)
      WHERE JSONB_ARRAY_LENGTH(COALESCE(taxonomy_item.value->'added', '[]'::JSONB)) > 0

      UNION ALL

      SELECT 'taxonomy_removed:' || (taxonomy_item.value->>'taxonomy')
      FROM JSONB_ARRAY_ELEMENTS(COALESCE(result->'taxonomies', '[]'::JSONB)) AS taxonomy_item(value)
      WHERE JSONB_ARRAY_LENGTH(COALESCE(taxonomy_item.value->'removed', '[]'::JSONB)) > 0

      UNION ALL SELECT 'term_added'
      WHERE EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(COALESCE(result->'taxonomies', '[]'::JSONB)) AS taxonomy_item(value)
        WHERE JSONB_ARRAY_LENGTH(COALESCE(taxonomy_item.value->'added', '[]'::JSONB)) > 0
      )

      UNION ALL SELECT 'term_removed'
      WHERE EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(COALESCE(result->'taxonomies', '[]'::JSONB)) AS taxonomy_item(value)
        WHERE JSONB_ARRAY_LENGTH(COALESCE(taxonomy_item.value->'removed', '[]'::JSONB)) > 0
      )

      UNION ALL SELECT 'images'
      WHERE result->'images'->>'changed' = 'true'

      UNION ALL SELECT 'variation:size'
      WHERE JSONB_ARRAY_LENGTH(COALESCE(result->'variations'->'added', '[]'::JSONB)) > 0
         OR JSONB_ARRAY_LENGTH(COALESCE(result->'variations'->'removed', '[]'::JSONB)) > 0

      UNION ALL SELECT 'variation:price'
      WHERE JSONB_ARRAY_LENGTH(COALESCE(result->'variations'->'after', '[]'::JSONB)) > 0
         OR EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(COALESCE(result->'variations'->'items', '[]'::JSONB)) AS variation_item(value)
        WHERE variation_item.value->>'price_managed' = 'true'
      )

      UNION ALL SELECT 'variation:stock'
      WHERE JSONB_ARRAY_LENGTH(COALESCE(result->'variations'->'after', '[]'::JSONB)) > 0
         OR EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(COALESCE(result->'variations'->'items', '[]'::JSONB)) AS variation_item(value)
        WHERE variation_item.value->>'stock_changed' = 'true'
      )

      UNION ALL SELECT 'variations'
      WHERE JSONB_ARRAY_LENGTH(COALESCE(result->'variations'->'added', '[]'::JSONB)) > 0
         OR JSONB_ARRAY_LENGTH(COALESCE(result->'variations'->'removed', '[]'::JSONB)) > 0
         OR JSONB_ARRAY_LENGTH(COALESCE(result->'variations'->'items', '[]'::JSONB)) > 0
    ) flags
    WHERE flag IS NOT NULL
    ORDER BY flag
  ), ARRAY[]::TEXT[]);
$$;

CREATE TABLE wordpress_catalog_item_read_models (
  item_id BIGINT PRIMARY KEY,
  run_id BIGINT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  wordpress_variation_count INTEGER NOT NULL DEFAULT 0 CHECK (wordpress_variation_count >= 0),
  wordpress_image_count INTEGER NOT NULL DEFAULT 0 CHECK (wordpress_image_count >= 0),
  audit_risk TEXT CHECK (audit_risk IN ('none', 'review', 'danger', 'blocked')),
  change_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO wordpress_catalog_item_read_models (
  item_id, run_id, title, search_text, image_url, wordpress_variation_count,
  wordpress_image_count, audit_risk, change_flags, updated_at
)
SELECT item.id,
       item.run_id,
       COALESCE(snapshot.payload->'product'->>'title', ''),
       CONCAT_WS(' ',
         snapshot.payload->'product'->>'title', item.wordpress_product_id::TEXT,
         item.source_product_id::TEXT, item.internal_product_id::TEXT,
         item.source_external_id, item.legacy_goat_id, item.sku
       ),
       COALESCE(
         snapshot.payload->'product'->'images'->0->>'url',
         snapshot.payload->'product'->'images'->0->>'source_url',
         snapshot.payload->'product'->'images'->0->>'origin_url'
       ),
       JSONB_ARRAY_LENGTH(COALESCE(snapshot.payload->'product'->'variations', '[]'::JSONB)),
       JSONB_ARRAY_LENGTH(COALESCE(snapshot.payload->'product'->'images', '[]'::JSONB)),
       CASE
         WHEN item.audit_status = 'blocked' THEN 'blocked'
         WHEN item.audit_result->>'risk' IN ('none', 'review', 'danger') THEN item.audit_result->>'risk'
       END,
       wordpress_catalog_audit_change_flags(item.audit_result),
       item.updated_at
FROM wordpress_catalog_run_items item
JOIN wordpress_catalog_snapshots snapshot ON snapshot.id = item.snapshot_id;

CREATE INDEX wordpress_catalog_item_read_models_run_idx
  ON wordpress_catalog_item_read_models (run_id, item_id);

CREATE INDEX wordpress_catalog_item_read_models_risk_idx
  ON wordpress_catalog_item_read_models (run_id, audit_risk, item_id);

CREATE INDEX wordpress_catalog_item_read_models_change_flags_idx
  ON wordpress_catalog_item_read_models USING GIN (change_flags);

CREATE INDEX wordpress_catalog_item_read_models_search_idx
  ON wordpress_catalog_item_read_models USING GIN (LOWER(search_text) gin_trgm_ops);
