UPDATE reference_types
SET cardinality = 'single',
    updated_at = NOW()
WHERE code = 'category'
  AND cardinality <> 'single';
