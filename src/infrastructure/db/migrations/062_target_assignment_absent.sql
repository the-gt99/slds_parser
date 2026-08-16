ALTER TABLE target_assignment_rule_conditions
  DROP CONSTRAINT target_assignment_rule_conditions_operator_check;

ALTER TABLE target_assignment_rule_conditions
  ADD CONSTRAINT target_assignment_rule_conditions_operator_check
  CHECK (operator IN ('equals', 'one_of', 'contains_phrase', 'regex', 'absent'));
