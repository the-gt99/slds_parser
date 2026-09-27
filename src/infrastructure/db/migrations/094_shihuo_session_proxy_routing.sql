ALTER TABLE shihuo_guest_devices
  ADD COLUMN outbound_proxy_ciphertext TEXT,
  ADD COLUMN inventory_success_count BIGINT NOT NULL DEFAULT 0 CHECK (inventory_success_count >= 0),
  ADD COLUMN inventory_failure_count BIGINT NOT NULL DEFAULT 0 CHECK (inventory_failure_count >= 0),
  ADD COLUMN inventory_total_duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (inventory_total_duration_ms >= 0);
