ALTER TABLE target_content_templates
  ADD COLUMN preserve_existing_story BOOLEAN NOT NULL DEFAULT FALSE;
