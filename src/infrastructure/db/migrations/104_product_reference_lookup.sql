-- migrate: concurrent-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS internal_products_reference_lookup_idx
ON internal_products USING GIN (product_reference_tokens(data))
WHERE data ? 'referenceCandidates';
