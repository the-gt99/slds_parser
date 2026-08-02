UPDATE reference_types
SET cardinality = 'multiple',
    updated_at = NOW()
WHERE code = 'category'
  AND cardinality <> 'multiple';
