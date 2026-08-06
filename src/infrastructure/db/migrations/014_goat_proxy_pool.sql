CREATE TABLE goat_proxies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  protocol TEXT NOT NULL CHECK (protocol IN ('http', 'socks5')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  credentials_ciphertext TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  health_status TEXT NOT NULL DEFAULT 'untested' CHECK (health_status IN ('untested', 'healthy', 'unhealthy')),
  last_tested_at TIMESTAMPTZ,
  last_test_latency_ms INTEGER CHECK (last_test_latency_ms IS NULL OR last_test_latency_ms >= 0),
  last_test_error TEXT,
  last_used_at TIMESTAMPTZ,
  success_count BIGINT NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count BIGINT NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX goat_proxies_available_idx
  ON goat_proxies (enabled, health_status, id)
  WHERE enabled = TRUE AND health_status = 'healthy';

CREATE TABLE goat_proxy_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proxy_id BIGINT REFERENCES goat_proxies(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'test', 'enable', 'disable')),
  actor TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX goat_proxy_audit_proxy_created_idx
  ON goat_proxy_audit (proxy_id, created_at DESC);
