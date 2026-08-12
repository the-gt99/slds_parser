DROP TRIGGER IF EXISTS target_dictionary_values_export_revision_update
  ON target_dictionary_values;

CREATE OR REPLACE FUNCTION bump_target_export_revision_for_dictionary_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO target_export_revisions (target_id, revision, updated_at)
  SELECT DISTINCT target_id, 1, NOW()
  FROM (
    SELECT old_row.target_id
    FROM old_dictionary_rows old_row
    JOIN new_dictionary_rows new_row ON new_row.id = old_row.id
    WHERE ROW(
      old_row.target_id,
      old_row.entity_type,
      old_row.external_id,
      old_row.name,
      old_row.slug,
      old_row.parent_external_id,
      old_row.taxonomy,
      old_row.attribute_code,
      old_row.metadata,
      old_row.active
    ) IS DISTINCT FROM ROW(
      new_row.target_id,
      new_row.entity_type,
      new_row.external_id,
      new_row.name,
      new_row.slug,
      new_row.parent_external_id,
      new_row.taxonomy,
      new_row.attribute_code,
      new_row.metadata,
      new_row.active
    )
    UNION
    SELECT new_row.target_id
    FROM old_dictionary_rows old_row
    JOIN new_dictionary_rows new_row ON new_row.id = old_row.id
    WHERE ROW(
      old_row.target_id,
      old_row.entity_type,
      old_row.external_id,
      old_row.name,
      old_row.slug,
      old_row.parent_external_id,
      old_row.taxonomy,
      old_row.attribute_code,
      old_row.metadata,
      old_row.active
    ) IS DISTINCT FROM ROW(
      new_row.target_id,
      new_row.entity_type,
      new_row.external_id,
      new_row.name,
      new_row.slug,
      new_row.parent_external_id,
      new_row.taxonomy,
      new_row.attribute_code,
      new_row.metadata,
      new_row.active
    )
  ) changed
  WHERE target_id IS NOT NULL
  ON CONFLICT (target_id) DO UPDATE
  SET revision = target_export_revisions.revision + 1,
      updated_at = NOW();
  RETURN NULL;
END;
$$;

CREATE TRIGGER target_dictionary_values_export_revision_update
AFTER UPDATE ON target_dictionary_values
REFERENCING OLD TABLE AS old_dictionary_rows NEW TABLE AS new_dictionary_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_target_export_revision_for_dictionary_updates();
