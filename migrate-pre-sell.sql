-- Pre-sell shipments (sold before they landed). Idempotent; safe to re-run.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS pre_sell BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE items   ADD COLUMN IF NOT EXISTS pre_sell BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS items_pre_sell_idx ON items (batch_id, sku, size) WHERE pre_sell;
