-- A compact, source-only lookup. This never contains resulting target assignments.
CREATE OR REPLACE FUNCTION rules_v2_candidate_tokens(candidates JSONB)
RETURNS TEXT[] LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(ARRAY_AGG(DISTINCT
    'candidate.' || SPLIT_PART(field.key, '.', 2) || '.sourceValue=' ||
    LOWER(BTRIM(NORMALIZE(candidate->>'sourceValue', NFKC),
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') COLLATE "C")
  ), '{}'::TEXT[])
  FROM JSONB_EACH(candidates) field
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(field.value) candidate
  WHERE field.key IN ('product.brand', 'product.model', 'product.category')
    AND JSONB_TYPEOF(candidate->'sourceValue') = 'string'
$$;
