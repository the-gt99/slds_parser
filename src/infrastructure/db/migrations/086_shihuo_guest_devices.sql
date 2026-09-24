CREATE TABLE shihuo_guest_devices (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'onboarding'
    CHECK (status IN ('onboarding', 'ready', 'paused', 'revoked', 'error')),
  wireguard_public_key TEXT NOT NULL UNIQUE,
  wireguard_ip INET NOT NULL UNIQUE,
  onboarding_token_hash TEXT,
  onboarding_expires_at TIMESTAMPTZ,
  challenge TEXT NOT NULL UNIQUE,
  guest_profile_ciphertext TEXT,
  client_private_key_ciphertext TEXT,
  diagnostic_stage TEXT NOT NULL DEFAULT 'wireguard_not_connected'
    CHECK (diagnostic_stage IN (
      'wireguard_not_connected', 'traffic_not_seen', 'certificate_not_trusted',
      'challenge_not_found', 'authorized_request_rejected', 'profile_incomplete',
      'ready', 'paused', 'revoked', 'error'
    )),
  diagnostic_message TEXT,
  last_handshake_at TIMESTAMPTZ,
  last_traffic_at TIMESTAMPTZ,
  last_request_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX shihuo_guest_devices_status_idx
  ON shihuo_guest_devices (status, created_at DESC);

CREATE INDEX shihuo_guest_devices_onboarding_token_idx
  ON shihuo_guest_devices (onboarding_token_hash)
  WHERE onboarding_token_hash IS NOT NULL;

CREATE TABLE shihuo_guest_device_audit (
  id BIGSERIAL PRIMARY KEY,
  device_id BIGINT REFERENCES shihuo_guest_devices(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX shihuo_guest_device_audit_device_idx
  ON shihuo_guest_device_audit (device_id, created_at DESC);
