CREATE INDEX IF NOT EXISTS target_dictionary_values_target_external_active_idx
  ON target_dictionary_values (target_id, external_id)
  WHERE active = TRUE;

WITH candidates AS (
  SELECT
    mapping.target_id,
    mapping.reference_value_id,
    COALESCE(NULLIF(BTRIM(target.config->'targetScopeMap'->>'product.tag'), ''), 'product.tag') AS target_scope,
    related.id AS dictionary_value_id,
    JSONB_BUILD_OBJECT(
      'managedBy', 'target_term_relation',
      'relationCode', 'landing',
      'relationLabel', CASE source.entity_type
        WHEN 'brands' THEN 'Посадочная бренда'
        ELSE 'Посадочная модели'
      END,
      'sourceTypeCode', type.code,
      'sourceTargetScope', mapping.target_scope,
      'sourceDictionaryValueId', source.id::TEXT,
      'sourceLabel', source.name
    ) AS metadata
  FROM target_value_mappings mapping
  JOIN targets target ON target.id = mapping.target_id
  JOIN reference_values value ON value.id = mapping.reference_value_id AND value.enabled = TRUE
  JOIN reference_types type ON type.id = value.type_id AND type.code IN ('brand', 'model')
  JOIN target_dictionary_values source
    ON source.id = mapping.dictionary_value_id
   AND source.target_id = mapping.target_id
   AND source.entity_type IN ('brands', 'models')
   AND source.active = TRUE
  JOIN target_dictionary_values related
    ON related.target_id = mapping.target_id
   AND related.entity_type = 'tags'
   AND related.external_id = source.metadata#>>'{rawMeta,tag_id}'
   AND related.active = TRUE
  WHERE mapping.active = TRUE
    AND (target.exporter_code = 'wordpress' OR target.config->>'dictionaryProviderCode' = 'wordpress')
    AND ((type.code = 'brand' AND source.entity_type = 'brands')
      OR (type.code = 'model' AND source.entity_type = 'models'))
    AND COALESCE(source.metadata#>>'{rawMeta,tag_id}', '') ~ '^[1-9][0-9]*$'
), inserted AS (
  INSERT INTO target_reference_projections (
    target_id, reference_value_id, target_scope, dictionary_value_id, metadata, created_by
  )
  SELECT target_id, reference_value_id, target_scope, dictionary_value_id, metadata, 'migration:039'
  FROM candidates
  ON CONFLICT (target_id, reference_value_id, target_scope, dictionary_value_id) DO NOTHING
  RETURNING *
)
INSERT INTO target_reference_projection_history (
  projection_id, action, previous_value, new_value, actor, reason
)
SELECT id, 'create', NULL, TO_JSONB(inserted), 'migration:039', 'Добавлена посадочная метка связанного термина WordPress'
FROM inserted;
