UPDATE targets
SET config = config || '{"assignTitleBrandMentions": true}'::JSONB,
    updated_at = NOW()
WHERE exporter_code = 'wordpress'
   OR config->>'dictionaryProviderCode' = 'wordpress';
