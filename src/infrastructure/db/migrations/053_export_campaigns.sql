CREATE TABLE target_export_campaigns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES targets(id),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'completed')),
  actor TEXT NOT NULL,
  reason TEXT,
  preflight_window INTEGER NOT NULL CHECK (preflight_window BETWEEN 1 AND 100),
  max_exports INTEGER CHECK (max_exports IS NULL OR max_exports > 0),
  acknowledged_failed_count INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_failed_count >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX target_export_campaigns_one_running_idx
  ON target_export_campaigns (target_id)
  WHERE status = 'running';

CREATE INDEX target_export_campaigns_target_created_idx
  ON target_export_campaigns (target_id, created_at DESC, id DESC);

ALTER TABLE target_export_batches
  ADD COLUMN campaign_id BIGINT REFERENCES target_export_campaigns(id) ON DELETE SET NULL;

CREATE INDEX target_export_batches_campaign_idx
  ON target_export_batches (campaign_id, id)
  WHERE campaign_id IS NOT NULL;
