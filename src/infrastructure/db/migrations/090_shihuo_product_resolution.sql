ALTER TABLE shihuo_guest_devices
  ADD COLUMN last_used_at TIMESTAMPTZ,
  ADD COLUMN next_available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN leased_until TIMESTAMPTZ,
  ADD COLUMN lease_owner TEXT,
  ADD COLUMN consecutive_errors INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  ADD COLUMN cooldown_reason TEXT;

CREATE INDEX shihuo_guest_devices_available_idx
  ON shihuo_guest_devices (next_available_at, last_used_at NULLS FIRST)
  WHERE status = 'ready' AND guest_profile_ciphertext IS NOT NULL;

CREATE TABLE shihuo_product_links (
  id BIGSERIAL PRIMARY KEY,
  source_product_id BIGINT NOT NULL UNIQUE REFERENCES source_products(id) ON DELETE CASCADE,
  source_article TEXT NOT NULL,
  normalized_article TEXT NOT NULL,
  goods_id TEXT,
  style_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','resolved','not_found','article_mismatch','temporarily_blocked','failed')),
  confirmation_method TEXT CHECK (confirmation_method IS NULL OR confirmation_method = 'exact_article'),
  confirmed_article TEXT,
  confirmed_at TIMESTAMPTZ,
  last_card_loaded_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'resolved' AND goods_id IS NOT NULL AND style_id IS NOT NULL
    AND confirmation_method = 'exact_article' AND confirmed_at IS NOT NULL)
    OR (status <> 'resolved' AND goods_id IS NULL AND style_id IS NULL))
);

CREATE UNIQUE INDEX shihuo_product_links_confirmed_ids_idx
  ON shihuo_product_links (goods_id, style_id, source_product_id)
  WHERE status = 'resolved';
