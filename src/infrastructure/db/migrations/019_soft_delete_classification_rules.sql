ALTER TABLE source_reference_rules
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by TEXT;

CREATE INDEX source_reference_rules_not_deleted_idx
  ON source_reference_rules (reference_type_id, source_id, enabled, priority DESC)
  WHERE deleted_at IS NULL;
