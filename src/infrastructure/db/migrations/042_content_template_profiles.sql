DROP INDEX IF EXISTS uq_target_content_templates_active;

ALTER TABLE target_content_templates
  ADD COLUMN profile_key TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN profile_name TEXT NOT NULL DEFAULT 'Основной профиль',
  ADD COLUMN management_mode TEXT NOT NULL DEFAULT 'manage',
  ADD COLUMN category_term_ids BIGINT[] NOT NULL DEFAULT '{}',
  ADD COLUMN required_context_paths TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE target_content_templates
  ADD CONSTRAINT target_content_templates_profile_key_check
    CHECK (profile_key ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  ADD CONSTRAINT target_content_templates_profile_name_check
    CHECK (BTRIM(profile_name) <> ''),
  ADD CONSTRAINT target_content_templates_management_mode_check
    CHECK (management_mode IN ('manage', 'preserve'));

CREATE UNIQUE INDEX uq_target_content_templates_active_profile
  ON target_content_templates (target_id, field_code, profile_key)
  WHERE status = 'active';
