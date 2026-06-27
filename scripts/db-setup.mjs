// One-off schema setup / migration for the Postgres database.
//   npm run db:setup
// Reads DATABASE_URL from .env (or the process env on a server) and creates /
// upgrades the tables the app needs. Safe to re-run (IF NOT EXISTS + idempotent
// ALTERs). V5: uses the standard `pg` driver (local Postgres, not Neon HTTP).
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// Load .env into process.env if DATABASE_URL isn't already present.
if (!process.env.DATABASE_URL) {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (add it to .env).');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /\bsslmode=require\b|\.neon\.tech/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
});
const sql = (text) => pool.query(text);

console.log('Creating / migrating tables…');

await sql(`
  CREATE TABLE IF NOT EXISTS users (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT        NOT NULL,
    username    TEXT        NOT NULL UNIQUE,            -- stored lowercased
    pass_hash   TEXT        NOT NULL,
    role        TEXT        NOT NULL DEFAULT 'warehouse' CHECK (role IN ('warehouse','admin','ph_team')),
    status      TEXT        NOT NULL DEFAULT 'pending'  CHECK (status IN ('pending','approved','rejected')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT
  )
`);
// Roles: admin · warehouse · ph_team. Migrate any legacy 'employee' rows to
// 'warehouse' before re-asserting the constraint (idempotent on existing DBs).
await sql(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
await sql(`UPDATE users SET role = 'warehouse' WHERE role = 'employee'`);
await sql(`ALTER TABLE users ALTER COLUMN role SET DEFAULT 'warehouse'`);
await sql(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('warehouse','admin','ph_team'))`);

await sql(`
  CREATE TABLE IF NOT EXISTS login_attempts (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username   TEXT,
    ip         TEXT,
    success    BOOLEAN     NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS login_attempts_username_idx ON login_attempts (username, created_at)`);
await sql(`CREATE INDEX IF NOT EXISTS login_attempts_ip_idx       ON login_attempts (ip, created_at)`);

// Distributed mutex (single atomic SQL upsert per acquire) — serializes writes.
await sql(`
  CREATE TABLE IF NOT EXISTS locks (
    key          TEXT PRIMARY KEY,
    locked_until TIMESTAMPTZ NOT NULL
  )
`);

/* ---- inventory (batches, items, history, issues) ---- */

await sql(`CREATE SEQUENCE IF NOT EXISTS batch_seq START 100001`);
await sql(`CREATE SEQUENCE IF NOT EXISTS vin_seq   START 1`); // VINs: SBM-<YYMMDD>-000001

await sql(`
  CREATE TABLE IF NOT EXISTS batches (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_code      TEXT UNIQUE NOT NULL DEFAULT ('B-' || nextval('batch_seq')),
    buyer_name      TEXT,
    supplier_name   TEXT,
    tracking_number TEXT,
    date_received   DATE,
    default_cost    NUMERIC(12,2),
    notes           TEXT,
    special_rules   TEXT,
    status          TEXT NOT NULL DEFAULT 'committed',
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    committed_at    TIMESTAMPTZ
  )
`);
// Intake type: 'receiving' (a shipment) or 'rescale' (already-in-hand stock).
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS kind   TEXT NOT NULL DEFAULT 'receiving'`);
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS origin TEXT`);
await sql(`ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_kind_check`);
await sql(`ALTER TABLE batches ADD CONSTRAINT batches_kind_check CHECK (kind IN ('receiving','rescale'))`);

await sql(`
  CREATE TABLE IF NOT EXISTS items (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vin         TEXT UNIQUE NOT NULL DEFAULT ('SB-' || nextval('vin_seq')),
    batch_id    BIGINT REFERENCES batches(id) ON DELETE CASCADE,
    name        TEXT,
    sku         TEXT,
    size        TEXT,
    upc         TEXT,
    image_url   TEXT,
    cost        NUMERIC(12,2),
    source      TEXT,   -- 'stockx' | 'alias' | 'kicksdb' | 'manual'
    status      TEXT NOT NULL DEFAULT 'needs_shelf',
    notes       TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS items_batch_idx   ON items (batch_id)`);
await sql(`CREATE INDEX IF NOT EXISTS items_sku_idx     ON items (sku)`);
await sql(`CREATE INDEX IF NOT EXISTS items_created_idx ON items (created_at)`);
await sql(`CREATE INDEX IF NOT EXISTS items_status_idx  ON items (status)`);

// V5 columns (idempotent) — receiving "With Box" + PH Team editable fields.
await sql(`ALTER TABLE items ALTER COLUMN status SET DEFAULT 'needs_shelf'`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS with_box           BOOLEAN NOT NULL DEFAULT true`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS price              NUMERIC(12,2)`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS global_indicator   NUMERIC(12,2)`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS added_to_intel_inv BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS synced_alias       BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS synced_stockx      BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS synced_shopify     BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS ph_note            TEXT`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS last_edit_by       TEXT`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS last_edit_at       TIMESTAMPTZ`);
// First PH edit (who "added" the pricing) — set once; last_edit_* tracks the most
// recent change so the grid can show "Added by" + "Last edited by".
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS first_edit_by      TEXT`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS first_edit_at      TIMESTAMPTZ`);
// Gender/age group (Men | Women | Youth | Toddler | Unisex) — from the product
// lookup (Alias gender, else derived from StockX size suffix) for store listing.
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gender             TEXT`);
// Colorway (e.g. "Black/Varsity Royal/White") — from the product lookup, used on
// the no-box box-style label alongside the UPC barcode.
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS colorway           TEXT`);
// Restock pending — set when a unit is rescaled/restocked; cleared when the team
// marks it restocked (it then drops off the Rescale list into normal inventory).
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS restock_pending    BOOLEAN NOT NULL DEFAULT false`);
await sql(`CREATE INDEX IF NOT EXISTS items_restock_idx ON items (restock_pending) WHERE restock_pending`);
// Align the VIN column default to the real format (SBM-YYMMDD-######). This
// default is only a fallback — every insert supplies a VIN — but keeping it
// consistent avoids ever minting a stray "SB-…" id. Idempotent.
await sql(`ALTER TABLE items ALTER COLUMN vin SET DEFAULT
  ('SBM-' || to_char(current_date, 'YYMMDD') || '-' || lpad(nextval('vin_seq')::text, 6, '0'))`);

await sql(`
  CREATE TABLE IF NOT EXISTS item_events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id     BIGINT REFERENCES items(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,   -- 'scanned'|'received'|'status_change'|'issue'|'note'|'moved'|'sold'|'ph_update'
    details     JSONB,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS item_events_item_idx ON item_events (item_id, created_at)`);

await sql(`
  CREATE TABLE IF NOT EXISTS shipment_issues (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id       BIGINT REFERENCES batches(id) ON DELETE CASCADE,
    type           TEXT NOT NULL,
    description    TEXT,
    expected_count INT,
    received_count INT,
    created_by     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

// Product catalog — cached shoe details keyed by UPC (the box-label barcode).
// Sourced primarily from Alias (the only API that returns a `catalog_id` plus a
// full colorway). Powers Box Labels (name/size/colorway/sku) and stores the
// Alias `catalog_id` used to fetch the Global Indicator price. One row per UPC
// (a UPC encodes a specific size); the SKU's catalog_id is shared across sizes.
await sql(`
  CREATE TABLE IF NOT EXISTS products (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    upc         TEXT UNIQUE,
    sku         TEXT,
    size        TEXT,
    name        TEXT,
    colorway    TEXT,
    gender      TEXT,
    brand       TEXT,
    image_url   TEXT,
    catalog_id  TEXT,        -- Alias product id (for pricing_insights / GI)
    source      TEXT,        -- where the details came from (alias/stockx/kicksdb)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS products_sku_idx     ON products (sku)`);
await sql(`CREATE INDEX IF NOT EXISTS products_catalog_idx ON products (catalog_id)`);
// One catalog row per SKU when there's no box UPC (SKU-scanned products). Lets the
// SKU upsert path use a clean ON CONFLICT and blocks concurrent duplicate inserts.
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS products_sku_nullupc_idx ON products (sku) WHERE upc IS NULL`);

// PH-Team edit locks (presence). One row per VIN currently being edited; a lock
// is "active" while its heartbeat is fresh (the client pings every ~10s; locks
// older than the ~30s TTL are stealable). Used to show "being edited by X" and
// to block a second editor on the same consolidated row.
await sql(`
  CREATE TABLE IF NOT EXISTS edit_locks (
    vin          TEXT PRIMARY KEY,
    holder       TEXT NOT NULL,
    holder_id    TEXT NOT NULL,
    claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS edit_locks_hb_idx ON edit_locks (heartbeat_at)`);

// PH-requested rescales — PH flags a SKU (sizes/qty, current price, reason) for
// the warehouse to recount/rescan. Warehouse resolves from its inbox.
await sql(`
  CREATE TABLE IF NOT EXISTS rescale_requests (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku          TEXT NOT NULL,
    name         TEXT,
    sizes        JSONB,            -- [{ size, qty }]
    price        NUMERIC(12,2),
    reason       TEXT,
    note         TEXT,
    status       TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'done'
    requested_by TEXT,
    resolved_by  TEXT,
    resolved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS rescale_requests_open_idx ON rescale_requests (status) WHERE status = 'open'`);
// Warehouse audit results: actual qty per size counted on the shelf (+ a note).
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS actual_sizes JSONB`);
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS audit_note   TEXT`);

// Future — profit tracking. Schema now, UI later.
await sql(`
  CREATE TABLE IF NOT EXISTS sales (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id     BIGINT UNIQUE REFERENCES items(id) ON DELETE CASCADE,
    sale_price  NUMERIC(12,2),
    fees        NUMERIC(12,2),
    sold_at     TIMESTAMPTZ,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

/* ---- V6: custom suppliers, multi-box batches, listing photos ---- */

// Feature 1 — auto-saved supplier names. Seeded with the built-in list + new
// vendors; the receiving commit upserts any custom name typed by staff.
await sql(`
  CREATE TABLE IF NOT EXISTS suppliers (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT UNIQUE NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`
  INSERT INTO suppliers (name) VALUES
    ('Sunny'),('Nike'),('Foot Locker'),('DTLR'),('Snipes'),
    ('Champs'),('Finish Line'),('Shoe Palace'),('JD Sports')
  ON CONFLICT (name) DO NOTHING
`);

// Feature 7 — a batch can be several boxes arriving over days. It stays 'open'
// while boxes trickle in, then 'committed'/'done' (auto when received==expected,
// or a manual mark-done; status is changeable anytime). batch_tag is the
// handwritten code on the shipping label (free text). expected_boxes is the
// "X OF N" printed on the label. duplicate_of flags a re-used tracking number.
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS batch_tag      TEXT`);
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS expected_boxes INT`);
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS duplicate_of   BIGINT REFERENCES batches(id)`);
await sql(`CREATE INDEX IF NOT EXISTS batches_tracking_idx ON batches (tracking_number)`);

// One row per physical box in a batch; each box carries its own tracking number.
await sql(`
  CREATE TABLE IF NOT EXISTS batch_boxes (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id        BIGINT REFERENCES batches(id) ON DELETE CASCADE,
    box_number      INT,
    tracking_number TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'received'
    received_by     TEXT,
    received_at     TIMESTAMPTZ,
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
// `created_by` (who added the box) — idempotent for DBs created before it existed.
await sql(`ALTER TABLE batch_boxes ADD COLUMN IF NOT EXISTS created_by TEXT`);
await sql(`CREATE INDEX IF NOT EXISTS batch_boxes_batch_idx    ON batch_boxes (batch_id)`);
await sql(`CREATE INDEX IF NOT EXISTS batch_boxes_tracking_idx ON batch_boxes (tracking_number)`);

// Link each unit to the box it came in (and thus that box's tracking number).
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS box_id BIGINT REFERENCES batch_boxes(id)`);
await sql(`CREATE INDEX IF NOT EXISTS items_box_idx ON items (box_id)`);

// Feature 5 — listing photos keyed by SKU (shared across same-SKU units), shot
// by warehouse during scanning. Up to 5 named angles; re-capturing an angle
// replaces it (unique per sku+angle). Defect photos are NOT here — they ride the
// per-unit item_events(type='issue') record. Files live in Cloudflare R2.
await sql(`
  CREATE TABLE IF NOT EXISTS product_photos (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku        TEXT NOT NULL,
    angle      TEXT,            -- 'side' | 'diagonal' | 'outsole' | 'top' | 'rear'
    url        TEXT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS product_photos_sku_idx ON product_photos (sku)`);
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS product_photos_sku_angle_idx ON product_photos (sku, angle)`);

const { rows: [{ count }] } = await sql(`SELECT count(*)::int AS count FROM users`);
const { rows: [{ b }] } = await sql(`SELECT count(*)::int AS b FROM batches`);
console.log(`✓ Tables ready. users: ${count}, batches: ${b}`);
await pool.end();
