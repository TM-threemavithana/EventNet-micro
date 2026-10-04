ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS request_key VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS payments_request_key_unique
  ON payments (request_key)
  WHERE request_key IS NOT NULL;
