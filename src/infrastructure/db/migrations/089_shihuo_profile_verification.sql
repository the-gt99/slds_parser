ALTER TABLE shihuo_guest_devices
  ADD COLUMN last_verification_at TIMESTAMPTZ;

ALTER TABLE shihuo_guest_devices
  DROP CONSTRAINT shihuo_guest_devices_diagnostic_stage_check;

ALTER TABLE shihuo_guest_devices
  ADD CONSTRAINT shihuo_guest_devices_diagnostic_stage_check
  CHECK (diagnostic_stage IN (
    'wireguard_not_connected', 'traffic_not_seen', 'certificate_not_trusted',
    'certificate_trusted', 'challenge_not_found', 'authorized_request_rejected',
    'profile_incomplete', 'profile_captured', 'verification_in_progress',
    'verification_failed', 'ready', 'paused', 'revoked', 'error'
  ));
