ALTER TABLE runtime_worker_settings
  ADD COLUMN classification_apply_concurrency SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN applied_classification_apply_concurrency SMALLINT;

UPDATE runtime_worker_settings
SET applied_classification_apply_concurrency = classification_apply_concurrency
WHERE applied_revision IS NOT NULL;

ALTER TABLE runtime_worker_settings
  ADD CHECK (classification_apply_concurrency BETWEEN 1 AND 8),
  ADD CHECK (applied_classification_apply_concurrency IS NULL OR applied_classification_apply_concurrency BETWEEN 1 AND 8),
  ADD CHECK (
    (applied_revision IS NULL AND applied_classification_apply_concurrency IS NULL)
    OR
    (applied_revision IS NOT NULL AND applied_classification_apply_concurrency IS NOT NULL)
  );
