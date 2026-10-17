CREATE TABLE image_mirror_objects (
  destination_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  copied_at TIMESTAMPTZ,
  PRIMARY KEY(destination_id,object_key)
);
CREATE INDEX image_mirror_pending_idx ON image_mirror_objects(created_at) WHERE copied_at IS NULL;

ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN (
  'discover_source','collect_product','process_product','reclassify_product','retranslate_product',
  'sync_target_classifications','apply_target_classification_suggestion','preflight_product',
  'sync_wordpress_catalog','prepare_wordpress_variation_patches','collect_wordpress_variation_source',
  'collect_wordpress_goat_inventory','collect_wordpress_shihuo_inventory','combine_wordpress_inventory',
  'prepare_wordpress_variation_patch','refresh_wordpress_variation_patch',
  'submit_wordpress_variation_patches','poll_wordpress_variation_patches',
  'refresh_export_source','resolve_shihuo_product','export_product',
  'collect_product_content','translate_product_content',
  'check_product_images','refresh_product_images','export_product_images','mirror_image'
)) NOT VALID;
