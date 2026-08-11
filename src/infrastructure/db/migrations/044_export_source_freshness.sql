ALTER TABLE target_product_preflight_reviews
  ADD COLUMN source_refreshed_at TIMESTAMPTZ;

CREATE INDEX target_product_preflight_reviews_source_refresh_idx
  ON target_product_preflight_reviews (source_product_id, status, source_refreshed_at DESC);

CREATE OR REPLACE FUNCTION stale_target_product_preflight_review()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
    UPDATE target_product_preflight_reviews
    SET status = 'stale', updated_at = NOW()
    WHERE internal_product_id = NEW.id
      AND internal_content_hash <> NEW.content_hash
      AND status NOT IN ('stale', 'checking');
  END IF;
  RETURN NEW;
END;
$$;
