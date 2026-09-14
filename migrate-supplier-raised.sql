-- Supplier-raised purchase orders (PR #174). Idempotent; safe to re-run.

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS raised_by TEXT NOT NULL DEFAULT 'ph';
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_raised_by_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_raised_by_check
  CHECK (raised_by IN ('ph','supplier'));

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS labels_requested_at TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS labels_requested_by TEXT;
CREATE INDEX IF NOT EXISTS purchase_orders_labels_requested_idx
  ON purchase_orders (labels_requested_at) WHERE labels_requested_at IS NOT NULL;
