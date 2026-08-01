ALTER TABLE source_reference_decision_history
  DROP CONSTRAINT source_reference_decision_history_mapping_id_fkey,
  DROP CONSTRAINT source_reference_decision_history_rule_id_fkey,
  ADD CONSTRAINT source_reference_decision_history_mapping_id_fkey
    FOREIGN KEY (mapping_id) REFERENCES source_reference_mappings(id),
  ADD CONSTRAINT source_reference_decision_history_rule_id_fkey
    FOREIGN KEY (rule_id) REFERENCES source_reference_rules(id);
