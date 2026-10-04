-- Source candidate lookup is independent of target readiness and assignments.
CREATE FUNCTION product_reference_tokens(product_data JSONB)
RETURNS TEXT[] LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT public.rules_v2_candidate_tokens(COALESCE(JSONB_OBJECT_AGG('product.' || type_code, candidates), '{}'::JSONB))
  FROM (
    SELECT candidate->>'typeCode' AS type_code, JSONB_AGG(candidate) AS candidates
    FROM JSONB_ARRAY_ELEMENTS(CASE WHEN JSONB_TYPEOF(product_data->'referenceCandidates') = 'array'
      THEN product_data->'referenceCandidates' ELSE '[]'::JSONB END) candidate
    WHERE candidate->>'typeCode' IN ('brand', 'model', 'category')
    GROUP BY candidate->>'typeCode'
  ) groups
$$;
