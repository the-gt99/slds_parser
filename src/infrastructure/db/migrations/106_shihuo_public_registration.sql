ALTER TABLE shihuo_guest_devices ALTER COLUMN wireguard_ip DROP NOT NULL;
ALTER TABLE shihuo_guest_devices DROP CONSTRAINT shihuo_guest_devices_diagnostic_stage_check;
ALTER TABLE shihuo_guest_devices ADD CONSTRAINT shihuo_guest_devices_diagnostic_stage_check
  CHECK (diagnostic_stage IN ('wireguard_not_connected', 'traffic_not_seen', 'certificate_not_trusted',
    'certificate_trusted', 'challenge_not_found', 'authorized_request_rejected', 'profile_incomplete',
    'profile_captured', 'verification_in_progress', 'verification_failed', 'duplicate_profile',
    'ready', 'paused', 'revoked', 'error'));

CREATE TABLE shihuo_public_registrations (
  request_hash TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  device_id BIGINT REFERENCES shihuo_guest_devices(id) ON DELETE SET NULL,
  token_ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX shihuo_public_registrations_ip_idx ON shihuo_public_registrations(ip_hash, created_at);

CREATE TABLE shihuo_profile_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  device_id BIGINT REFERENCES shihuo_guest_devices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
