CREATE TABLE IF NOT EXISTS product_admin_batch_actions (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  filter JSONB NOT NULL,
  dry_run JSONB NOT NULL,
  created_job_ids JSONB NOT NULL,
  actor TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

