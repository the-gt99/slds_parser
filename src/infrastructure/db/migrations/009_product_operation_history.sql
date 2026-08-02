CREATE TABLE product_operation_executions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id UUID NOT NULL,
  source_product_id BIGINT NOT NULL REFERENCES source_products(id) ON DELETE CASCADE,
  operation_code TEXT NOT NULL,
  operation_name TEXT NOT NULL,
  operation_version TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  error TEXT,
  CHECK (
    (status = 'running' AND finished_at IS NULL AND error IS NULL)
    OR (status = 'completed' AND finished_at IS NOT NULL AND error IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND error IS NOT NULL)
  ),
  UNIQUE (attempt_id, sequence)
);

CREATE INDEX product_operation_executions_product_started_idx
  ON product_operation_executions (source_product_id, started_at DESC, sequence);
