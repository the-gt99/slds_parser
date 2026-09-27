ALTER TABLE goat_proxies
  ADD COLUMN service_code TEXT NOT NULL DEFAULT 'goat' CHECK (service_code IN ('goat', 'shihuo')),
  ADD COLUMN country_code TEXT NOT NULL DEFAULT 'UN' CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD COLUMN shihuo_device_id BIGINT REFERENCES shihuo_guest_devices(id) ON DELETE RESTRICT;

ALTER TABLE goat_proxies
  ADD CONSTRAINT goat_proxies_service_target_check CHECK (
    (service_code = 'goat' AND shihuo_device_id IS NULL)
    OR (service_code = 'shihuo' AND shihuo_device_id IS NOT NULL)
  );

CREATE UNIQUE INDEX goat_proxies_shihuo_device_idx
  ON goat_proxies (shihuo_device_id)
  WHERE service_code = 'shihuo';
