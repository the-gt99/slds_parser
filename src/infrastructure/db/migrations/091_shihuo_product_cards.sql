CREATE TABLE shihuo_product_cards (
  source_product_id BIGINT PRIMARY KEY REFERENCES source_products(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  loaded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX shihuo_product_cards_loaded_at_idx ON shihuo_product_cards (loaded_at);
