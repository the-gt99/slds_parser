ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (
  job_type IN ('discover_source', 'collect_product', 'process_product', 'preflight_product', 'export_product')
);

CREATE TABLE target_export_revisions (
  target_id BIGINT PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO target_export_revisions (target_id)
SELECT id FROM targets
ON CONFLICT (target_id) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_target_export_revision_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, updated_at)
  SELECT DISTINCT target_id, 1, NOW()
  FROM changed_target_rows
  WHERE target_id IS NOT NULL
  ON CONFLICT (target_id) DO UPDATE
  SET revision = target_export_revisions.revision + 1,
      updated_at = NOW();
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_target_export_revision_for_assignment_actions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, updated_at)
  SELECT DISTINCT rule.target_id, 1, NOW()
  FROM changed_action_rows action
  JOIN target_assignment_rules rule ON rule.id = action.rule_id
  ON CONFLICT (target_id) DO UPDATE
  SET revision = target_export_revisions.revision + 1,
      updated_at = NOW();
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_target_export_revision_for_target()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, updated_at)
  VALUES (NEW.id, 1, NOW())
  ON CONFLICT (target_id) DO UPDATE
  SET revision = target_export_revisions.revision + 1,
      updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER target_assignment_rule_actions_export_revision_insert
AFTER INSERT ON target_assignment_rule_actions
REFERENCING NEW TABLE AS changed_action_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_for_assignment_actions();

CREATE TRIGGER target_assignment_rule_actions_export_revision_update
AFTER UPDATE ON target_assignment_rule_actions
REFERENCING NEW TABLE AS changed_action_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_for_assignment_actions();

CREATE TRIGGER target_assignment_rule_actions_export_revision_delete
AFTER DELETE ON target_assignment_rule_actions
REFERENCING OLD TABLE AS changed_action_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_for_assignment_actions();

CREATE TRIGGER targets_export_revision_insert
AFTER INSERT ON targets
FOR EACH ROW EXECUTE FUNCTION bump_target_export_revision_for_target();

CREATE TRIGGER targets_export_revision_update
AFTER UPDATE OF config ON targets
FOR EACH ROW WHEN (OLD.config IS DISTINCT FROM NEW.config)
EXECUTE FUNCTION bump_target_export_revision_for_target();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'target_value_mappings',
    'target_classification_projections',
    'target_reference_projections',
    'target_assignment_rules',
    'target_dictionary_values'
  ] LOOP
    EXECUTE FORMAT(
      'CREATE TRIGGER %I_export_revision_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS changed_target_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_statement()',
      table_name,
      table_name
    );
    EXECUTE FORMAT(
      'CREATE TRIGGER %I_export_revision_update AFTER UPDATE ON %I REFERENCING NEW TABLE AS changed_target_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_statement()',
      table_name,
      table_name
    );
    EXECUTE FORMAT(
      'CREATE TRIGGER %I_export_revision_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS changed_target_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_statement()',
      table_name,
      table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION bump_target_export_revision_for_changed_templates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, updated_at)
  SELECT DISTINCT target_id, 1, NOW()
  FROM changed_template_rows
  WHERE status = 'active'
  ON CONFLICT (target_id) DO UPDATE
  SET revision = target_export_revisions.revision + 1,
      updated_at = NOW();
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_target_export_revision_for_updated_templates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, updated_at)
  SELECT DISTINCT target_id, 1, NOW()
  FROM (
    SELECT target_id FROM old_template_rows WHERE status = 'active'
    UNION
    SELECT target_id FROM new_template_rows WHERE status = 'active'
  ) changed
  ON CONFLICT (target_id) DO UPDATE
  SET revision = target_export_revisions.revision + 1,
      updated_at = NOW();
  RETURN NULL;
END;
$$;

CREATE TRIGGER target_content_templates_export_revision_insert
AFTER INSERT ON target_content_templates
REFERENCING NEW TABLE AS changed_template_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_for_changed_templates();

CREATE TRIGGER target_content_templates_export_revision_update
AFTER UPDATE ON target_content_templates
REFERENCING OLD TABLE AS old_template_rows NEW TABLE AS new_template_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_for_updated_templates();

CREATE TRIGGER target_content_templates_export_revision_delete
AFTER DELETE ON target_content_templates
REFERENCING OLD TABLE AS changed_template_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_for_changed_templates();

CREATE TABLE target_product_preflight_reviews (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  internal_product_id BIGINT NOT NULL REFERENCES internal_products(id) ON DELETE CASCADE,
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  source_code TEXT NOT NULL,
  source_external_id TEXT,
  title TEXT NOT NULL,
  image_url TEXT,
  search_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('checking', 'ready', 'blocked', 'error', 'stale')),
  phase TEXT NOT NULL,
  internal_content_hash TEXT NOT NULL,
  configuration_revision BIGINT NOT NULL CHECK (configuration_revision > 0),
  payload_hash TEXT,
  external_id TEXT,
  will_create BOOLEAN,
  matched_by TEXT,
  risk_level TEXT NOT NULL DEFAULT 'none' CHECK (risk_level IN ('none', 'review', 'danger')),
  change_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  field_change_count INTEGER NOT NULL DEFAULT 0 CHECK (field_change_count >= 0),
  taxonomy_added_count INTEGER NOT NULL DEFAULT 0 CHECK (taxonomy_added_count >= 0),
  taxonomy_removed_count INTEGER NOT NULL DEFAULT 0 CHECK (taxonomy_removed_count >= 0),
  image_change_count INTEGER NOT NULL DEFAULT 0 CHECK (image_change_count >= 0),
  variation_change_count INTEGER NOT NULL DEFAULT 0 CHECK (variation_change_count >= 0),
  deactivated_variation_count INTEGER NOT NULL DEFAULT 0 CHECK (deactivated_variation_count >= 0),
  blockers JSONB NOT NULL DEFAULT '[]'::JSONB,
  change_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  error TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (JSONB_TYPEOF(blockers) = 'array'),
  CHECK (JSONB_TYPEOF(change_summary) = 'object'),
  CHECK ((status = 'ready' AND payload_hash ~ '^[a-f0-9]{64}$' AND will_create IS NOT NULL)
    OR status <> 'ready'),
  UNIQUE (target_id, internal_product_id),
  UNIQUE (target_id, source_product_id)
);

CREATE INDEX target_product_preflight_reviews_list_idx
  ON target_product_preflight_reviews (target_id, checked_at DESC, id DESC);

CREATE INDEX target_product_preflight_reviews_status_idx
  ON target_product_preflight_reviews (
    target_id, status, configuration_revision, checked_at DESC, id DESC
  );

CREATE INDEX target_product_preflight_reviews_ready_idx
  ON target_product_preflight_reviews (
    target_id, configuration_revision, checked_at DESC, id DESC
  ) WHERE status = 'ready';

CREATE INDEX target_product_preflight_reviews_operation_idx
  ON target_product_preflight_reviews (
    target_id, will_create, status, checked_at DESC, id DESC
  ) WHERE status = 'ready';

CREATE INDEX target_product_preflight_reviews_risk_idx
  ON target_product_preflight_reviews (
    target_id, risk_level, status, checked_at DESC, id DESC
  );

CREATE INDEX target_product_preflight_reviews_internal_idx
  ON target_product_preflight_reviews (internal_product_id);

CREATE INDEX target_product_preflight_reviews_external_idx
  ON target_product_preflight_reviews (target_id, source_external_id)
  WHERE source_external_id IS NOT NULL;

CREATE INDEX target_product_preflight_reviews_flags_idx
  ON target_product_preflight_reviews USING GIN (change_flags);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX target_product_preflight_reviews_search_idx
  ON target_product_preflight_reviews USING GIN (search_text gin_trgm_ops);

CREATE INDEX internal_products_preflight_candidates_idx
  ON internal_products (updated_at DESC, id DESC)
  INCLUDE (source_product_id, content_hash)
  WHERE status = 'classified'
    AND data->'classification'->>'status' = 'complete';

CREATE INDEX jobs_active_preflight_product_idx
  ON jobs ((payload->>'targetId'), (payload->>'sourceProductId'))
  WHERE job_type = 'preflight_product' AND status IN ('pending', 'running', 'retry');

CREATE INDEX jobs_export_control_product_history_idx
  ON jobs ((payload->>'targetId'), (payload->>'internalProductId'), created_at DESC, id DESC)
  WHERE job_type = 'export_product';

CREATE OR REPLACE FUNCTION stale_target_product_preflight_review()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
    UPDATE target_product_preflight_reviews
    SET status = 'stale', updated_at = NOW()
    WHERE internal_product_id = NEW.id
      AND internal_content_hash <> NEW.content_hash
      AND status <> 'stale';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER internal_products_stale_preflight_review
AFTER UPDATE OF content_hash ON internal_products
FOR EACH ROW EXECUTE FUNCTION stale_target_product_preflight_review();

CREATE OR REPLACE FUNCTION stale_preflight_review_after_target_attempt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE target_product_preflight_reviews
  SET status = 'stale', phase = 'post_export', updated_at = NOW()
  WHERE target_id = NEW.target_id
    AND internal_product_id = NEW.internal_product_id
    AND status <> 'checking';
  RETURN NEW;
END;
$$;

CREATE TRIGGER target_products_stale_preflight_after_insert
AFTER INSERT ON target_products
FOR EACH ROW EXECUTE FUNCTION stale_preflight_review_after_target_attempt();

CREATE TRIGGER target_products_stale_preflight_after_update
AFTER UPDATE OF status, external_id, last_attempt_at, synced_at ON target_products
FOR EACH ROW EXECUTE FUNCTION stale_preflight_review_after_target_attempt();

CREATE TABLE target_export_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  filter JSONB NOT NULL DEFAULT '{}'::JSONB,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (JSONB_TYPEOF(filter) = 'object')
);

CREATE INDEX target_export_batches_target_created_idx
  ON target_export_batches (target_id, created_at DESC, id DESC);

CREATE TABLE target_export_batch_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES target_export_batches(id) ON DELETE CASCADE,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  preflight_review_id BIGINT REFERENCES target_product_preflight_reviews(id) ON DELETE SET NULL,
  source_product_id BIGINT NOT NULL REFERENCES source_products(id),
  internal_product_id BIGINT NOT NULL REFERENCES internal_products(id),
  approved_payload_hash TEXT NOT NULL CHECK (approved_payload_hash ~ '^[a-f0-9]{64}$'),
  approved_will_create BOOLEAN NOT NULL,
  approved_external_id TEXT,
  approved_matched_by TEXT,
  job_id BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, internal_product_id)
);

CREATE INDEX target_export_batch_items_batch_idx
  ON target_export_batch_items (batch_id, id);

CREATE INDEX target_export_batch_items_job_idx
  ON target_export_batch_items (job_id) WHERE job_id IS NOT NULL;
