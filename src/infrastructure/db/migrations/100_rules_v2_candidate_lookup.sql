-- migrate: concurrent-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS rules_v2_workbench_candidate_lookup_idx
ON rules_v2_workbench_items USING GIN (rules_v2_candidate_tokens(candidates));
