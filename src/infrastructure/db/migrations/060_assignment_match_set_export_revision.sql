CREATE TRIGGER target_assignment_match_sets_export_revision_insert
AFTER INSERT ON target_assignment_match_sets
REFERENCING NEW TABLE AS changed_target_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_statement();

CREATE TRIGGER target_assignment_match_sets_export_revision_update
AFTER UPDATE ON target_assignment_match_sets
REFERENCING NEW TABLE AS changed_target_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_statement();

CREATE TRIGGER target_assignment_match_sets_export_revision_delete
AFTER DELETE ON target_assignment_match_sets
REFERENCING OLD TABLE AS changed_target_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_statement();

CREATE OR REPLACE FUNCTION bump_target_export_revision_for_assignment_match_set_values()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, remote_revision, updated_at)
  SELECT DISTINCT match_set.target_id, 1, 1, NOW()
  FROM changed_match_set_value_rows value
  JOIN target_assignment_match_sets match_set ON match_set.id = value.match_set_id
  ON CONFLICT (target_id) DO UPDATE
  SET revision = target_export_revisions.revision + 1,
      remote_revision = target_export_revisions.remote_revision + 1,
      updated_at = NOW();
  RETURN NULL;
END;
$$;

CREATE TRIGGER target_assignment_match_set_values_export_revision_insert
AFTER INSERT ON target_assignment_match_set_values
REFERENCING NEW TABLE AS changed_match_set_value_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_for_assignment_match_set_values();

CREATE TRIGGER target_assignment_match_set_values_export_revision_update
AFTER UPDATE ON target_assignment_match_set_values
REFERENCING NEW TABLE AS changed_match_set_value_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_for_assignment_match_set_values();

CREATE TRIGGER target_assignment_match_set_values_export_revision_delete
AFTER DELETE ON target_assignment_match_set_values
REFERENCING OLD TABLE AS changed_match_set_value_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_for_assignment_match_set_values();
