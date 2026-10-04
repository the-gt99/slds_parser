-- migrate: concurrent-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS rules_v2_workbench_data_ready_page_idx
ON rules_v2_workbench_items (source_id, target_id,
  (issue_count - (CASE WHEN 'required_brand_missing' = ANY(issue_codes) THEN 1 ELSE 0 END
    + CASE WHEN 'required_model_missing' = ANY(issue_codes) THEN 1 ELSE 0 END
    + CASE WHEN 'required_category_missing' = ANY(issue_codes) THEN 1 ELSE 0 END)) ASC,
  ((CASE WHEN 'required_brand_missing' = ANY(issue_codes) THEN 1 ELSE 0 END
    + CASE WHEN 'required_model_missing' = ANY(issue_codes) THEN 1 ELSE 0 END
    + CASE WHEN 'required_category_missing' = ANY(issue_codes) THEN 1 ELSE 0 END)) DESC,
  product_updated_at DESC, source_product_id DESC)
INCLUDE (status, issue_codes, issue_count)
WHERE product_updated_at IS NOT NULL;
