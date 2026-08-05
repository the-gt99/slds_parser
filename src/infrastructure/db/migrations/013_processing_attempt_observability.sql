CREATE TABLE product_processing_attempts (
  attempt_id UUID PRIMARY KEY,
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  processor_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  processor_output JSONB NOT NULL,
  operations_output JSONB,
  classified_output JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  error TEXT,
  CHECK (JSONB_TYPEOF(processor_output) = 'object'),
  CHECK (operations_output IS NULL OR JSONB_TYPEOF(operations_output) = 'object'),
  CHECK (classified_output IS NULL OR JSONB_TYPEOF(classified_output) = 'object'),
  CHECK (
    (status = 'running' AND finished_at IS NULL AND error IS NULL)
    OR (status = 'completed' AND finished_at IS NOT NULL AND error IS NULL
        AND operations_output IS NOT NULL AND classified_output IS NOT NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND error IS NOT NULL)
  )
);

CREATE INDEX product_processing_attempts_product_started_idx
  ON product_processing_attempts (source_product_id, started_at DESC);

ALTER TABLE product_operation_executions
  ADD COLUMN output_data JSONB;

ALTER TABLE product_operation_executions
  ADD CONSTRAINT product_operation_executions_output_object_check
  CHECK (output_data IS NULL OR JSONB_TYPEOF(output_data) = 'object');
