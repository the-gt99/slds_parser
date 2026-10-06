CREATE TABLE product_content_enrichments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  donor_code TEXT NOT NULL,
  donor_product_key TEXT NOT NULL,
  article TEXT NOT NULL,
  field TEXT NOT NULL DEFAULT 'description' CHECK (field = 'description'),
  source_locale TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  raw_payload JSONB NOT NULL,
  cleaned_text TEXT NOT NULL,
  translated_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('collected','applied','skipped')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_product_id, donor_code, field),
  CHECK(status <> 'applied' OR (length(trim(cleaned_text)) > 0 AND length(trim(translated_text)) > 0))
);

-- Existing rows were validated by the previous constraint. Avoid scanning the
-- entire job history while holding a deployment transaction open.
ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN (
  'discover_source','collect_product','process_product','reclassify_product','retranslate_product',
  'sync_target_classifications','apply_target_classification_suggestion','preflight_product',
  'sync_wordpress_catalog','prepare_wordpress_variation_patches','collect_wordpress_variation_source',
  'collect_wordpress_goat_inventory','collect_wordpress_shihuo_inventory','combine_wordpress_inventory',
  'prepare_wordpress_variation_patch','refresh_wordpress_variation_patch',
  'submit_wordpress_variation_patches','poll_wordpress_variation_patches',
  'refresh_export_source','resolve_shihuo_product','export_product',
  'collect_product_content','translate_product_content'
)) NOT VALID;
