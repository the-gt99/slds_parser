DROP INDEX classification_candidates_phrase_search_idx;

ALTER TABLE classification_candidates DROP COLUMN phrase_search_value;

ALTER TABLE classification_candidates
  ADD COLUMN phrase_search_value TEXT GENERATED ALWAYS AS (
    ' ' || BTRIM(REGEXP_REPLACE(
      REGEXP_REPLACE(
        BTRIM(REGEXP_REPLACE(LOWER(normalized_source_value), '[^[:alnum:]]+', ' ', 'g')),
        '(^| )(wmns|womens|mens)( |$)', ' ', 'g'
      ),
      '[[:space:]]+', ' ', 'g'
    )) || ' '
  ) STORED;

CREATE INDEX classification_candidates_phrase_search_idx
  ON classification_candidates USING GIN (phrase_search_value gin_trgm_ops);
