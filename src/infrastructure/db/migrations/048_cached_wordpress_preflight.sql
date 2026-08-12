ALTER TABLE target_export_revisions
  ADD COLUMN remote_revision BIGINT;

UPDATE target_export_revisions
SET remote_revision = revision;

ALTER TABLE target_export_revisions
  ALTER COLUMN remote_revision SET DEFAULT 1,
  ALTER COLUMN remote_revision SET NOT NULL,
  ADD CONSTRAINT target_export_revisions_remote_revision_check CHECK (remote_revision > 0);

ALTER TABLE target_product_preflight_reviews
  ADD COLUMN remote_revision BIGINT,
  ADD COLUMN wordpress_checked_at TIMESTAMPTZ,
  ADD COLUMN wordpress_state_hash TEXT,
  ADD COLUMN used_cached_wordpress BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN preflight_cache JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD CONSTRAINT target_product_preflight_reviews_wordpress_state_hash_check
    CHECK (wordpress_state_hash IS NULL OR wordpress_state_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT target_product_preflight_reviews_preflight_cache_check
    CHECK (JSONB_TYPEOF(preflight_cache) = 'object');

UPDATE target_product_preflight_reviews review
SET remote_revision = revision.remote_revision,
    wordpress_checked_at = review.checked_at
FROM target_export_revisions revision
WHERE revision.target_id = review.target_id
  AND review.configuration_revision = revision.revision;

ALTER TABLE target_export_batch_items
  ADD COLUMN approved_wordpress_state_hash TEXT,
  ADD CONSTRAINT target_export_batch_items_wordpress_state_hash_check
    CHECK (approved_wordpress_state_hash IS NULL OR approved_wordpress_state_hash ~ '^[a-f0-9]{64}$');

CREATE OR REPLACE FUNCTION bump_target_export_revision_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, remote_revision, updated_at)
  SELECT DISTINCT target_id, 1, 1, NOW()
  FROM changed_target_rows
  WHERE target_id IS NOT NULL
  ON CONFLICT (target_id) DO UPDATE
  SET revision = target_export_revisions.revision + 1,
      remote_revision = target_export_revisions.remote_revision + 1,
      updated_at = NOW();
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_target_export_revision_for_assignment_actions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, remote_revision, updated_at)
  SELECT DISTINCT rule.target_id, 1, 1, NOW()
  FROM changed_action_rows action
  JOIN target_assignment_rules rule ON rule.id = action.rule_id
  ON CONFLICT (target_id) DO UPDATE
  SET revision = target_export_revisions.revision + 1,
      remote_revision = target_export_revisions.remote_revision + 1,
      updated_at = NOW();
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_target_export_revision_for_target()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, remote_revision, updated_at)
  VALUES (NEW.id, 1, 1, NOW())
  ON CONFLICT (target_id) DO UPDATE
  SET revision = target_export_revisions.revision + 1,
      remote_revision = target_export_revisions.remote_revision + 1,
      updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION bump_target_export_revision_for_changed_templates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, remote_revision, updated_at)
  SELECT DISTINCT target_id, 1, 1, NOW()
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
  INSERT INTO target_export_revisions (target_id, revision, remote_revision, updated_at)
  SELECT DISTINCT target_id, 1, 1, NOW()
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
