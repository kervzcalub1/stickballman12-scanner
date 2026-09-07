-- Empty shoe boxes, warehouse side (PR #168). Idempotent; safe to re-run.

ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_kind_check;
ALTER TABLE batches ADD CONSTRAINT batches_kind_check
  CHECK (kind IN ('receiving','rescale','instore','existing','boxes'));

ALTER TABLE items ADD COLUMN IF NOT EXISTS dimensions TEXT;
CREATE INDEX IF NOT EXISTS items_dimensions_idx ON items (sku, size, dimensions)
  WHERE dimensions IS NOT NULL;

ALTER TABLE items ADD COLUMN IF NOT EXISTS used_on_item_id BIGINT REFERENCES items(id);
ALTER TABLE items ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS items_used_on_idx ON items (used_on_item_id)
  WHERE used_on_item_id IS NOT NULL;
