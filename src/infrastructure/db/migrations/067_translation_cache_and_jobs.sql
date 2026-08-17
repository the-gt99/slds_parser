ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (
  job_type IN (
    'discover_source',
    'collect_product',
    'process_product',
    'reclassify_product',
    'retranslate_product',
    'sync_target_classifications',
    'apply_target_classification_suggestion',
    'preflight_product',
    'export_product',
    'sync_wordpress_catalog',
    'prepare_wordpress_variation_patches',
    'refresh_wordpress_variation_patch',
    'poll_wordpress_variation_patches'
  )
);

CREATE TABLE translation_cache (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_code TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  source_locale TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  source_text TEXT NOT NULL CHECK (source_text <> ''),
  translated_text TEXT NOT NULL CHECK (translated_text <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count BIGINT NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  UNIQUE (provider_code, provider_version, source_locale, target_locale, source_hash)
);

CREATE INDEX translation_cache_last_used_idx
  ON translation_cache (last_used_at);

CREATE INDEX jobs_retranslation_active_idx
  ON jobs (available_at, id)
  WHERE job_type = 'retranslate_product' AND status IN ('pending', 'retry');
