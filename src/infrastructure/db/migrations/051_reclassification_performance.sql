CREATE TABLE classification_rule_set_revisions (
  source_id BIGINT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO classification_rule_set_revisions (source_id)
SELECT DISTINCT source_id
FROM source_reference_rules
ON CONFLICT (source_id) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_classification_rule_set_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_source_id BIGINT;
BEGIN
  affected_source_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.source_id ELSE NEW.source_id END;
  INSERT INTO classification_rule_set_revisions (source_id, revision, updated_at)
  VALUES (affected_source_id, 1, NOW())
  ON CONFLICT (source_id) DO UPDATE SET
    revision = classification_rule_set_revisions.revision + 1,
    updated_at = NOW();
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_reference_rules_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON source_reference_rules
FOR EACH ROW EXECUTE FUNCTION bump_classification_rule_set_revision();

CREATE OR REPLACE FUNCTION bump_rule_sets_for_reference_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.enabled IS NOT DISTINCT FROM OLD.enabled THEN
    RETURN NEW;
  END IF;
  INSERT INTO classification_rule_set_revisions (source_id, revision, updated_at)
  SELECT DISTINCT rule.source_id, 1, NOW()
  FROM source_reference_rules AS rule
  WHERE rule.reference_value_id = NEW.id
  ON CONFLICT (source_id) DO UPDATE SET
    revision = classification_rule_set_revisions.revision + 1,
    updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER reference_values_rule_set_revision_trigger
AFTER UPDATE OF enabled ON reference_values
FOR EACH ROW EXECUTE FUNCTION bump_rule_sets_for_reference_value();

DROP INDEX IF EXISTS jobs_claim_available_idx;

CREATE INDEX jobs_claim_available_idx
  ON jobs (job_type, available_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX jobs_reclassify_claim_available_idx
  ON jobs (available_at, id)
  WHERE job_type = 'reclassify_product' AND status IN ('pending', 'retry');

CREATE INDEX jobs_process_claim_available_idx
  ON jobs (available_at, id)
  WHERE job_type = 'process_product' AND status IN ('pending', 'retry');

ALTER TABLE internal_products SET (
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.01
);

ALTER TABLE source_product_classification_links SET (
  autovacuum_vacuum_threshold = 2000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_threshold = 2000,
  autovacuum_analyze_scale_factor = 0.01
);

ALTER TABLE classification_review_groups SET (
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.01
);

ANALYZE jobs;
ANALYZE source_reference_rules;
ANALYZE internal_products;
ANALYZE source_product_classification_links;
ANALYZE classification_review_groups;
