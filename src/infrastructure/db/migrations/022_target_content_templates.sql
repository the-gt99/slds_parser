CREATE TABLE target_content_templates (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  field_code TEXT NOT NULL CHECK (field_code IN ('description', 'short_description')),
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  template_source TEXT NOT NULL CHECK (BTRIM(template_source) <> ''),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor TEXT NOT NULL CHECK (BTRIM(actor) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  UNIQUE (target_id, field_code, revision)
);

CREATE UNIQUE INDEX uq_target_content_templates_active
  ON target_content_templates (target_id, field_code)
  WHERE status = 'active';

CREATE INDEX idx_target_content_templates_history
  ON target_content_templates (target_id, field_code, revision DESC);
