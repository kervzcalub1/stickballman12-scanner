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
    role        TEXT        NOT NULL DEFAULT 'warehouse' CHECK (role IN ('warehouse','admin','ph_team','supplier')),
    status      TEXT        NOT NULL DEFAULT 'pending'  CHECK (status IN ('pending','approved','rejected')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT
  )
`);
// Roles: admin · warehouse · ph_team · supplier. Migrate any legacy 'employee' rows
// to 'warehouse' before re-asserting the constraint (idempotent on existing DBs).
// `supplier` (external partners who scan out shipments — see the PO tables below) is
// admin-assigned only; signup never offers it (api/auth/signup.js).
await sql(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
await sql(`UPDATE users SET role = 'warehouse' WHERE role = 'employee'`);
await sql(`ALTER TABLE users ALTER COLUMN role SET DEFAULT 'warehouse'`);
await sql(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('warehouse','admin','ph_team','supplier'))`);

// Password reset: a user asks for a reset from the sign-in screen (reset_requested_at
// stamps the request so it shows in the admin's "Check Access" queue). An admin issues
// a temp password, which sets must_change_password = true; the user is then forced to
// pick a new one on their next sign-in before they can use the app.
await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_requested_at TIMESTAMPTZ`);

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

// App-wide settings (key/value). Currently holds `price_markup_pct` — the GI→Final
// markup percent, editable in-app by admin/superadmin (default 20 = +20%).
await sql(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT        NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`INSERT INTO app_settings (key, value) VALUES ('price_markup_pct', '20') ON CONFLICT (key) DO NOTHING`);

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
// Intake type: 'receiving' (a shipment), 'rescale' (already-in-hand stock),
// 'instore' (pairs bought at a retail store — no shipment; admin/warehouse only,
// never enters the PH-team / Intelligent-Inventory flow; `origin` = store name), or
// 'existing' (old stock that predates this system — already synced to II and the
// stores, so it also bypasses PH entirely; `origin` = where it was counted from).
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS kind   TEXT NOT NULL DEFAULT 'receiving'`);
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS origin TEXT`);
await sql(`ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_kind_check`);
await sql(`ALTER TABLE batches ADD CONSTRAINT batches_kind_check CHECK (kind IN ('receiving','rescale','instore','existing'))`);

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
// Which Alias pricing basis the GI came from: 'consigned' (daily-ops default) or
// 'with_you' (fallback when consigned was empty). null = manual/unknown/legacy.
// Drives the "WY" chip on the PH New-Inventory grid. See docs/context/ph-report.md.
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gi_basis           TEXT`);
// Snapshot of the Final price at the moment the shoe was listed (II turned on / a
// manual PH save while on II). A GI "Refresh prices" updates `price` but NOT this, so
// a later divergence (price <> listed_price while on II) surfaces the ⚠ "Price changed"
// drift chip on the PH grid — the live store listing is now at a stale price. See ph-report.md.
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS listed_price       NUMERIC(12,2)`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS added_to_intel_inv BOOLEAN NOT NULL DEFAULT false`);
// One-time baseline for shoes already on II before `listed_price` existed (only fills
// nulls, so it never masks a drift that's already been recorded).
// MUST run after the ADD COLUMN above, not before: on an EXISTING database
// `added_to_intel_inv` is already there so either order works, which is why this went
// unnoticed — but on a FRESH one the UPDATE aborted the whole migration with
// `column "added_to_intel_inv" does not exist`, so no new environment (or CI's
// ephemeral Postgres) could be provisioned at all.
await sql(`UPDATE items SET listed_price = price WHERE added_to_intel_inv AND listed_price IS NULL AND price IS NOT NULL`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS synced_alias       BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS synced_stockx      BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS synced_shopify     BOOLEAN NOT NULL DEFAULT false`);
// "GOAT only": warehouse flags a shoe as list-to-Alias(GOAT)+Intelligent-Inventory
// only — StockX/Shopify are N/A. PH is "done" at II+Alias for these. See
// docs/context/ph-report.md.
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS goat_only          BOOLEAN NOT NULL DEFAULT false`);
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
// In-store buys are listed to the stores MANUALLY by admin/warehouse (they skip the
// PH team / Intelligent-Inventory cascade). Separate per-store flags — NOT the PH
// synced_* columns — so the two workflows never conflate. The In-Store Listing page
// toggles these; a pair is "fully listed" when all three are true. `instore_listed_at`
// /_by record the last listing action (audit). Only meaningful for kind='instore'.
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS instore_listed_alias   BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS instore_listed_stockx  BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS instore_listed_shopify BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS instore_listed_at  TIMESTAMPTZ`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS instore_listed_by  TEXT`);
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
    status       TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'audited' | 'cancelled'
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
// PH per-size listing decision after the warehouse audit: GI + Final price and the
// II/AL/SX/SH sync flags. Array of { size, global_indicator, price,
// added_to_intel_inv, synced_alias, synced_stockx, synced_shopify }.
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS listing   JSONB`);
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS listed_by TEXT`);
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS listed_at TIMESTAMPTZ`);
// PH cancelling a request they raised in error. Only the reason needs a column —
// WHO cancelled and WHEN reuse resolved_by/resolved_at ("who ended this, and when"),
// with `status` saying how it ended. The warehouse's audit_note stays theirs alone.
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS cancel_note TEXT`);
// PH correcting a request it already submitted (wrong qty, forgot a size, wrong
// reason). Only WHO and WHEN are kept, not a per-field diff: while a request is still
// `open` nobody downstream has acted on it, so the old values answer no question the
// current ones don't — but "this changed after I read it" is a real question, and the
// warehouse needs the stamp to know its screen may be stale.
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS edited_by TEXT`);
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`);
// A re-released shoe carries several style codes. `sku` is what PH chose the warehouse
// should COUNT (one code, or all of them joined); `sku_all` keeps every code that
// matched, so narrowing to one code stays reversible on the edit form — without it,
// picking one would throw away the very list needed to pick differently later.
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS sku_all TEXT`);
// Which PAIRS a request was raised for. Written only when the request came off a New
// Inventory row (that is the only moment anything knows); a request typed on the
// standalone form names a SKU and no pairs, and stays unlinked.
//
// items.id, not vin: the primary key, so no question about sticker formats or roll
// stock can reach it. ON DELETE CASCADE on both sides — removing a pair (which HARD
// deletes the row, see inventory.md) must not strand a link pointing at nothing.
await sql(`
  CREATE TABLE IF NOT EXISTS rescale_request_items (
    request_id BIGINT NOT NULL REFERENCES rescale_requests(id) ON DELETE CASCADE,
    item_id    BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (request_id, item_id)
  )
`);
// The grid asks item -> request on every load, so that direction gets its own index.
await sql(`CREATE INDEX IF NOT EXISTS rescale_request_items_item_idx ON rescale_request_items (item_id)`);
// The end of the loop: `audited` used to be terminal, so the green "Audited" home badge
// counted up forever. `closed` is what the linked pairs having been dealt with looks like.
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS closed_by TEXT`);
await sql(`ALTER TABLE rescale_requests ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`);

// Pre-printed VIN/1ID roll stock ("VIN Project"). Blank stickers are minted and
// printed in bulk BEFORE anyone knows which shoe each will land on, so intake never
// depends on a working label printer: scan the shoe, scan the sticker, done.
//
// Its own sequence, not vin_seq: the roll series renders as SBM-R-000123, which is
// short enough to print at 0.34 mm bar width on a 1" label. Phone cameras (what the
// warehouse actually scans with) start missing below ~0.30 mm, and the dated
// 17-character VIN squeezes to 0.26 mm on the same stock.
await sql(`CREATE SEQUENCE IF NOT EXISTS vin_roll_seq START 1`); // roll VINs: SBM-R-000001
await sql(`
  CREATE TABLE IF NOT EXISTS vin_stock (
    vin              TEXT PRIMARY KEY,
    status           TEXT NOT NULL DEFAULT 'available',  -- available | assigned | void
    run_id           BIGINT,          -- which print run it came from (reprint a jammed run)
    printed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    printed_by       TEXT,
    assigned_item_id BIGINT,          -- items.id once it's on a shoe (NOT a FK: an item
                                      -- can be deleted, and the sticker still existed)
    assigned_at      TIMESTAMPTZ,
    voided_by        TEXT,            -- a torn/lost sticker is voided, never reused
    voided_at        TIMESTAMPTZ
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS vin_stock_status_idx ON vin_stock (status)`);
await sql(`CREATE INDEX IF NOT EXISTS vin_stock_run_idx ON vin_stock (run_id, vin)`);

// Deleted stock — the archive behind "remove pairs" on Inventory / New Inventory.
// The items row is genuinely DELETED (both pages, every count and the batch totals
// have to read true after a miscount is corrected), and item_events cascades away
// with it — so the whole row AND its history are frozen into JSONB here first.
// `item_json` keeps every column, so a future column on items is never lost by an
// archive written before it existed; the promoted columns are just what the
// Deleted page searches and sorts on.
await sql(`
  CREATE TABLE IF NOT EXISTS deleted_items (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vin         TEXT NOT NULL,
    item_id     BIGINT,           -- the original items.id (NOT a FK — the row is gone)
    sku         TEXT,
    name        TEXT,
    size        TEXT,
    status      TEXT,             -- status at the moment it was deleted
    batch_id    BIGINT,
    batch_code  TEXT,
    cost        NUMERIC(12,2),
    scanned_at  TIMESTAMPTZ,      -- the original items.created_at
    scanned_by  TEXT,
    reason      TEXT,
    item_json   JSONB NOT NULL,   -- the whole items row as it stood
    events      JSONB,            -- its full item_events history, frozen
    deleted_by  TEXT,
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS deleted_items_sku_idx ON deleted_items (sku)`);
await sql(`CREATE INDEX IF NOT EXISTS deleted_items_vin_idx ON deleted_items (vin)`);
await sql(`CREATE INDEX IF NOT EXISTS deleted_items_when_idx ON deleted_items (deleted_at DESC)`);

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

// HOW a batch came to belong to a purchase order (2026-08-28). `batches.po_id` says
// THAT it does, never how or when — and "received straight against the order" and
// "linked to it afterwards, once someone noticed" are different facts when you are
// tracing a pair. Older rows keep NULL here: unknown is reported as unknown rather than
// guessed from the link's existence.
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS po_link_source TEXT`);   // 'receiving' | 'linked'
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS po_linked_at TIMESTAMPTZ`);
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS po_linked_by TEXT`);

// Merging two batches that are really one inbound (2026-08-28, superadmin tool). The
// losing batch is NOT deleted: a batch code is printed on labels and quoted in PO
// history, so a code that stops resolving is a dead end for whoever is holding the paper.
// It stays as an emptied row pointing at the batch that absorbed it.
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS merged_into_batch_id BIGINT REFERENCES batches(id)`);
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ`);
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS merged_by TEXT`);
await sql(`CREATE INDEX IF NOT EXISTS batches_merged_into_idx ON batches (merged_into_batch_id)`);

// Feature 7 — a batch can be several boxes arriving over days. It stays 'open'
// while boxes trickle in, then 'committed'/'done' (auto when received==expected,
// or a manual mark-done; status is changeable anytime). batch_tag is the
// handwritten code on the shipping label (free text). expected_boxes is the
// "X OF N" printed on the label. duplicate_of flags a re-used tracking number.
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS batch_tag      TEXT`);
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS expected_boxes INT`);
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS duplicate_of   BIGINT REFERENCES batches(id)`);
// Some inbounds genuinely arrive with no tracking number (hand-delivered, local
// pickup, a supplier who never sent one). `no_tracking` is staff STATING that,
// which is a different fact from `tracking_number IS NULL` — the latter is just
// an empty field, and a receiving batch can't otherwise commit without one.
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS no_tracking    BOOLEAN NOT NULL DEFAULT false`);
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
    angle      TEXT,            -- 'side' | 'diagonal' | 'outsole' | 'top' | 'rear' | 'extra1' | 'extra2'
    url        TEXT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS product_photos_sku_idx ON product_photos (sku)`);
// PH edited photos live alongside the warehouse's raw shots for the same SKU/angle:
// `source` ∈ 'warehouse' | 'ph_edited'. Display prefers ph_edited (see db.js photo_url
// subqueries). Widen the unique key from (sku,angle) → (sku,angle,source) so both can
// coexist. 'extra1'/'extra2' are PH-only extra images (viewer + download, never a
// thumbnail/angle). See docs/context/ph-report.md.
await sql(`ALTER TABLE product_photos ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'warehouse'`);
await sql(`DROP INDEX IF EXISTS product_photos_sku_angle_idx`);
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS product_photos_sku_angle_source_idx ON product_photos (sku, angle, source)`);

// Shelf locations — physical put-away spots. code is the scannable barcode value
// (globally unique: SITE-AREA-BAY-SHELF, e.g. MNH-WH-A2-04). shelf is NULL for
// whole-bay spots (pods). Items link via items.location_id (+ a location_code
// snapshot for fast search/print). See docs/shelf-location-system-plan.md.
await sql(`
  CREATE TABLE IF NOT EXISTS locations (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code       TEXT UNIQUE NOT NULL,
    warehouse  TEXT NOT NULL,
    area       TEXT,
    bay        TEXT NOT NULL,
    shelf      INT,
    label      TEXT,
    active     BOOLEAN NOT NULL DEFAULT true,
    sort_order INT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS locations_warehouse_idx ON locations (warehouse, sort_order)`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS location_id   BIGINT REFERENCES locations(id)`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS location_code TEXT`);
await sql(`CREATE INDEX IF NOT EXISTS items_location_idx ON items (location_id)`);

/* ---- Purchase Orders: supplier scan-out → reconciled receiving (Phase 0) ----
   The order is created by the PH team (the "Form / Batch"), the supplier fills its
   contents by scanning, and a receiving `batch` later links back via `batches.po_id`
   to reconcile expected-vs-actual. Full design: docs/context/purchase-orders.md.
   NOTE: the supplier scan-out writes ONLY these tables — it must never run the
   receiving commit path (which mints VINs + inserts `items` = phantom stock). */
await sql(`CREATE SEQUENCE IF NOT EXISTS po_seq START 100001`); // PO codes: PO-100001…

// The order shell. `supplier_user_id` = the supplier account that fills it (nullable
// until assigned). `expected_boxes` = how many shipping labels PH said the batch has.
await sql(`
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    po_code           TEXT UNIQUE NOT NULL DEFAULT ('PO-' || nextval('po_seq')),
    supplier_name     TEXT NOT NULL,
    supplier_user_id  BIGINT REFERENCES users(id),
    status            TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','shipped','receiving','reconciled','closed')),
    tag_code          TEXT,                 -- Tag/Code Name from the PH form
    date_of_purchase  DATE,
    expected_boxes    INT,                  -- number of shipping labels in this batch
    notes             TEXT,
    created_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    shipped_at        TIMESTAMPTZ,          -- set when ALL labels are shipped
    received_batch_id BIGINT REFERENCES batches(id),
    reconciled_at     TIMESTAMPTZ,
    reconciliation    JSONB                 -- expected-vs-received snapshot at reconcile time
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx ON purchase_orders (supplier_user_id)`);
await sql(`CREATE INDEX IF NOT EXISTS purchase_orders_status_idx   ON purchase_orders (status)`);

// One row per shipping label (outbound mirror of batch_boxes). PH pre-assigns the
// real courier `tracking_number` per label; `carrier`/`tracking_status`/`last_checkpoint`
// are filled by the tracking aggregator (17TRACK) in a later phase. The PO flips to
// 'shipped' only once every label here is shipped.
await sql(`
  CREATE TABLE IF NOT EXISTS po_boxes (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    po_id           BIGINT REFERENCES purchase_orders(id) ON DELETE CASCADE,
    box_number      INT,
    tracking_number TEXT,
    carrier         TEXT,                   -- auto-detected by the tracking aggregator
    -- 'pending' (filling) → 'packed' (reviewed & closed, ready to ship) → 'shipped'
    -- → 'pre_transit' (label made, still with supplier) → 'in_transit' / 'delivered'
    -- (from tracking). Editing (scan) only while 'pending'.
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','packed','pre_transit','shipped','in_transit','delivered')),
    tracking_status TEXT,                   -- raw status from the aggregator
    last_checkpoint TEXT,
    checked_at      TIMESTAMPTZ,
    packed_at       TIMESTAMPTZ,
    shipped_at      TIMESTAMPTZ,
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS po_boxes_po_idx       ON po_boxes (po_id)`);
await sql(`CREATE INDEX IF NOT EXISTS po_boxes_tracking_idx ON po_boxes (tracking_number)`);
// Existing DBs: add the 'packed' review state + packed_at (the inline CHECK/columns
// above only apply to a fresh table). The CHECK gets Postgres's default name.
// The courier's labels PDF, kept in R2 so the supplier can print the label for the box
// they're packing instead of hunting for the email it came in. Stored ONCE per order,
// exactly as uploaded; `label_page` records which page of it belongs to each label, so a
// per-box download is a page extraction rather than N stored files. Removed from R2 when
// the order is archived — by then every box has landed and the label is spent.
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS labels_key         TEXT`);
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS labels_name        TEXT`);
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS labels_pages       INT`);
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS labels_uploaded_at TIMESTAMPTZ`);
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS labels_uploaded_by TEXT`);
await sql(`ALTER TABLE po_boxes ADD COLUMN IF NOT EXISTS label_page INT`);
// A label's pages RUN UNTIL THE NEXT LABEL. The sheets bought from UPS CampusShip put a
// packing slip after every label, and that slip belongs in that box — so a per-box
// download is a range (label + its slip), not a single page.
await sql(`ALTER TABLE po_boxes ADD COLUMN IF NOT EXISTS label_page_end INT`);
await sql(`ALTER TABLE po_boxes ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ`);
// The 17TRACK carrier code (chosen in the New Batch form / auto-detected from the labels
// PDF) — passed to 17TRACK's register/gettrackinfo so it pulls status from the right
// carrier. `carrier` (above) stays the display name the aggregator returns.
await sql(`ALTER TABLE po_boxes ADD COLUMN IF NOT EXISTS carrier_key INT`);
// Full checkpoint history (newest first) from the tracking aggregator, for the milestone
// timeline UI: [{ time, description, location, stage }].
await sql(`ALTER TABLE po_boxes ADD COLUMN IF NOT EXISTS tracking_events JSONB`);
// 17TRACK's `latest_status` carries { status, sub_status, sub_status_descr }. `status` is
// the coarse stage already mapped onto po_boxes.status and it's too blunt to act on —
// "Exception" doesn't say whether customs is holding the parcel or it's been sent back.
// Stored raw (e.g. Exception_Returning); src/lib/trackstatus.js turns it into words.
await sql(`ALTER TABLE po_boxes ADD COLUMN IF NOT EXISTS tracking_sub_status TEXT`);
await sql(`ALTER TABLE po_boxes ADD COLUMN IF NOT EXISTS tracking_sub_status_descr TEXT`);
await sql(`ALTER TABLE po_boxes DROP CONSTRAINT IF EXISTS po_boxes_status_check`);
await sql(`ALTER TABLE po_boxes ADD CONSTRAINT po_boxes_status_check CHECK (status IN ('pending','packed','pre_transit','shipped','in_transit','delivered'))`);


// The "what the supplier says he shipped" lines — one per SKU+size PER LABEL, so the
// same SKU+size can appear under different labels. Re-scanning a SKU/size increments
// qty_expected (mirrors receiving's per-size auto-increment).
await sql(`
  CREATE TABLE IF NOT EXISTS po_lines (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    po_id         BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    po_box_id     BIGINT NOT NULL REFERENCES po_boxes(id) ON DELETE CASCADE,
    sku           TEXT,
    size          TEXT,
    name          TEXT,
    upc           TEXT,
    colorway      TEXT,
    gender        TEXT,
    qty_expected  INT NOT NULL DEFAULT 0,
    unit_cost     NUMERIC(12,2),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS po_lines_po_idx ON po_lines (po_id)`);
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS po_lines_box_sku_size_idx ON po_lines (po_box_id, sku, size)`);

// On-behalf manifest entry: when a supplier doesn't scan out themselves, PH (or admin)
// can type their manifest for them. entered_by = the staff user who entered/last edited
// the line (NULL when the supplier scanned it themselves); entered_on_behalf flags a
// staff-entered line — the supplier sees a generic "<business> Staff" attribution while
// warehouse/PH see the real person (docs/context/purchase-orders.md).
// What the supplier paid, per pair, on the line it was paid for. A po_line is one
// SKU+SIZE, so both of these are per size: the same shoe can cost (and be tipped)
// differently in a 9 than in an 11. `unit_cost` already existed; `tip` is the money paid
// on top to get that pair — kept as its own column rather than folded into the cost so
// the two stay separately reportable.
await sql(`ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS tip NUMERIC(12,2)`);
await sql(`ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS entered_by BIGINT REFERENCES users(id)`);
await sql(`ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS entered_on_behalf BOOLEAN NOT NULL DEFAULT FALSE`);

// Supplier-facing business name for the on-behalf attribution ("<name>'s Staff").
// Configurable via app_settings; falls back to 'Stickballman12 LLC' in code when unset.
await sql(`
  INSERT INTO app_settings (key, value, updated_at)
  VALUES ('business_display_name', 'Stickballman12 LLC', now())
  ON CONFLICT (key) DO NOTHING
`);

// Whole-order manifest (Path C): when a supplier gives ONE list for the whole purchase
// (no per-box breakdown), PH enters it against the PO itself — po_lines with po_box_id
// NULL. `manifest_scope` flips to 'po' on the first such line; reconciliation then counts
// the whole list order-wide instead of per shipped label. A PO is one scope or the other.
// Receiving is still per box (like a blind receive). See docs/context/purchase-orders.md.
await sql(`ALTER TABLE po_lines ALTER COLUMN po_box_id DROP NOT NULL`);
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS manifest_scope TEXT NOT NULL DEFAULT 'box'`);
await sql(`ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_manifest_scope_check`);
await sql(`ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_manifest_scope_check CHECK (manifest_scope IN ('box','po'))`);
// Order-scoped lines have no box, so the per-label unique index doesn't cover them —
// this partial index keeps one line per (PO, sku, size) for the whole-order manifest.
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS po_lines_po_sku_size_idx ON po_lines (po_id, sku, size) WHERE po_box_id IS NULL`);

// Reconciliation note — the "why" behind a PO's outcome (what the supplier said about a
// shortage, what was credited, why it was closed out). One editable note per PO, written by
// warehouse/PH and shown READ-ONLY to the supplier, so it doubles as the message to them.
// `_by` stores the staff display name for the internal byline; the supplier's endpoints strip
// it and show a generic "From <business>" instead (they never see individual staff names).
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS reconcile_note TEXT`);
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS reconcile_note_by TEXT`);
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS reconcile_note_at TIMESTAMPTZ`);

/* ---- Discrepancy resolution -------------------------------------------------
   What happens AFTER an order comes up short: chase the supplier, agree a refund or a
   reship, wait for it to land. Two shapes on purpose —
   • po_resolutions is STATE: four known steps, so fixed columns and one row per order.
     Keeps "how many refunds are outstanding" a single indexed query with no join.
   • po_comments is a LOG: append-only, never read by a list screen.
   Folding the checklist into the log would turn every "is step 3 done?" into a scan. */
await sql(`
  CREATE TABLE IF NOT EXISTS po_resolutions (
    po_id           BIGINT PRIMARY KEY REFERENCES purchase_orders(id) ON DELETE CASCADE,
    outcome         TEXT,
    contacted_by    TEXT,
    contacted_at    TIMESTAMPTZ,
    outcome_by      TEXT,
    outcome_at      TIMESTAMPTZ,
    ref_value       TEXT,
    ref_amount      NUMERIC(12,2),
    ref_box_id      BIGINT REFERENCES po_boxes(id),
    ref_by          TEXT,
    ref_at          TIMESTAMPTZ,
    settled_amount  NUMERIC(12,2),
    settled_by      TEXT,
    settled_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`ALTER TABLE po_resolutions DROP CONSTRAINT IF EXISTS po_resolutions_outcome_check`);
await sql(`ALTER TABLE po_resolutions ADD CONSTRAINT po_resolutions_outcome_check
           CHECK (outcome IS NULL OR outcome IN ('refund','replacement','writeoff'))`);

// `audience` from day one, defaulting to internal: showing selected entries to the
// supplier later is then a flag on a row, not a migration. Author name is denormalised
// so the thread renders without joining users.
await sql(`
  CREATE TABLE IF NOT EXISTS po_comments (
    id          BIGSERIAL PRIMARY KEY,
    po_id       BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'note',
    audience    TEXT NOT NULL DEFAULT 'internal',
    body        TEXT NOT NULL,
    author_id   BIGINT,
    author_name TEXT,
    author_role TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await sql(`CREATE INDEX IF NOT EXISTS po_comments_po_idx ON po_comments (po_id, created_at DESC)`);

// Denormalised onto the PO so list screens and badges stay single-table — no join to
// po_resolutions or po_comments just to draw a chip. Written by the same endpoints that
// write the real rows, in the same request; never recomputed on read.
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS resolution_state TEXT NOT NULL DEFAULT 'none'`);
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS comment_count INT NOT NULL DEFAULT 0`);
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS last_comment_at TIMESTAMPTZ`);
await sql(`CREATE INDEX IF NOT EXISTS purchase_orders_resolution_idx
           ON purchase_orders (resolution_state) WHERE resolution_state <> 'none'`);

// A reship arrives on the ORIGINAL order as its own label. It carries no po_lines —
// those units were already declared and already counted short, so declaring them again
// would double the expected count and make chasing a shortage look like a bigger one.
await sql(`ALTER TABLE po_boxes ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'original'`);

// Link the received receiving-batch back to its PO (set on scan-in). Reconciliation
// joins po_lines (expected) against items under this batch (actual), by (sku, size).
await sql(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS po_id BIGINT REFERENCES purchase_orders(id)`);
await sql(`CREATE INDEX IF NOT EXISTS batches_po_idx ON batches (po_id)`);

// We don't only buy shoes. A shoe arrives with a crushed box, or with no box at all, so
// the same suppliers ship us EMPTY SHOE BOXES to swap in — ordered, manifested, tracked
// and reconciled exactly like a shipment of pairs. `order_kind` says which an order is;
// everything downstream of it (the manifest form, the chips, the printed sheets) reads
// this one column. Defaults to 'shoes' so every order raised before this stays what it was.
await sql(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS order_kind TEXT NOT NULL DEFAULT 'shoes'`);
await sql(`ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_order_kind_check`);
await sql(`ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_order_kind_check CHECK (order_kind IN ('shoes','boxes'))`);

// An empty box is identified by THREE things: the shoe it belongs to (SKU + name), the
// SIZE it was made for, and how big the carton is. A real empty shoe box is size-specific
// — the label on it carries the SKU, the size and the UPC — so a size 9 Panda box and a
// size 10 Panda box are two different things to order even where the carton measures the
// same. `dimensions` is the extra fact a box carries that a pair doesn't; it is not a
// replacement for the size.
await sql(`ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS dimensions TEXT`);
// Which line is "the same line" now depends on the kind of order, so the two kinds get a
// partial index each and stop overlapping. `dimensions IS NULL` is the shoe half — every
// row that existed before empty-box orders is in it, so adding the predicate changes
// nothing about what was already enforced.
await sql(`DROP INDEX IF EXISTS po_lines_box_sku_size_idx`);
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS po_lines_box_sku_size_idx
           ON po_lines (po_box_id, sku, size)
           WHERE dimensions IS NULL`);
await sql(`DROP INDEX IF EXISTS po_lines_po_sku_size_idx`);
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS po_lines_po_sku_size_idx
           ON po_lines (po_id, sku, size)
           WHERE po_box_id IS NULL AND dimensions IS NULL`);
// The box half. Re-declaring the same shoe, size AND carton under one label increments
// its qty; a different size, or the same size in a different carton, is its own row.
//
// DROP first, deliberately. An earlier cut of this keyed box lines on (sku, dimensions)
// with no size, and `CREATE UNIQUE INDEX IF NOT EXISTS` will happily leave a same-named
// index with the WRONG columns in place — which then fails at run time as
// "no unique or exclusion constraint matching the ON CONFLICT specification", because
// ON CONFLICT infers a partial index by its exact columns AND predicate. Any environment
// that ran that earlier version has to be corrected, and a no-op DROP costs nothing on
// one that didn't.
await sql(`DROP INDEX IF EXISTS po_lines_box_sku_dim_idx`);
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS po_lines_box_sku_dim_idx
           ON po_lines (po_box_id, sku, size, dimensions)
           WHERE po_box_id IS NOT NULL AND dimensions IS NOT NULL`);
await sql(`DROP INDEX IF EXISTS po_lines_po_sku_dim_idx`);
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS po_lines_po_sku_dim_idx
           ON po_lines (po_id, sku, size, dimensions)
           WHERE po_box_id IS NULL AND dimensions IS NOT NULL`);


/* ---- Payout Calculator: supplier presets ---- */
// A "supplier" here is the person who buys the pair at retail for us — Andrew,
// Esteban, Chris — and each one comes with a fixed cost stack: what they charge as a
// tip, what the box swap + labour ships for, the sales tax where they shop, and the
// gift-card discount they buy with. Retyping those four numbers for every pair, in a
// store aisle, on a phone, is how a wrong number ends up in a buy call.
//
// SHARED, not per device (unlike prefs.payoutRates): a supplier's tip fee is a fact
// about the supplier, so the buyer on the floor and the person checking the maths
// afterwards must see the same one. Edited in-app from the calculator.
//
// Every rate is stored, not just the four on the brief: applying a preset replaces the
// WHOLE cost stack, and a preset that left store/promo/cashback alone would quietly
// carry the last store trip's discount into the next supplier's numbers.
await sql(`
  CREATE TABLE IF NOT EXISTS payout_presets (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT          NOT NULL,
    tip_amt      NUMERIC(12,2) NOT NULL DEFAULT 0,
    shipping_amt NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_pct      NUMERIC(6,3)  NOT NULL DEFAULT 0,
    gift_pct     NUMERIC(6,3)  NOT NULL DEFAULT 0,
    store_pct    NUMERIC(6,3)  NOT NULL DEFAULT 0,
    promo_pct    NUMERIC(6,3)  NOT NULL DEFAULT 0,
    cashback_pct NUMERIC(6,3)  NOT NULL DEFAULT 0,
    note         TEXT,
    created_by   TEXT,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_by   TEXT,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
  )
`);
// Case-insensitive, so "andrew" can't become a second Andrew with different fees.
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS payout_presets_name_idx ON payout_presets (lower(btrim(name)))`);
// Which supplier ACCOUNT this stack belongs to (2026-08-26). A supplier signing in
// gets the Payout Calculator with only their own preset on it, so the link has to be
// an explicit id set by staff — matching on the preset's free-text name would break
// silently the first time either side is renamed, and the failure mode is one
// supplier reading another's cost stack. NULL = a preset with no account attached
// (staff-only, which is every preset until someone links one).
await sql(`ALTER TABLE payout_presets ADD COLUMN IF NOT EXISTS supplier_user_id BIGINT REFERENCES users(id)`);
await sql(`CREATE INDEX IF NOT EXISTS payout_presets_supplier_idx ON payout_presets (supplier_user_id)`);

// Seed the known suppliers — but ONLY into an empty table, never ON CONFLICT DO
// NOTHING. db:setup runs on every deploy, and a preset someone deliberately deleted
// must stay deleted rather than reappearing on the next push.
{
  const { rows: [{ n }] } = await sql(`SELECT count(*)::int AS n FROM payout_presets`);
  if (n === 0) {
    // tip · shipping (incl. box swap fee + labour) · sales tax · gift-card discount.
    // Council shops somewhere with no sales tax — that 0 is a fact, not a blank.
    await sql(`
      INSERT INTO payout_presets (name, tip_amt, shipping_amt, tax_pct, gift_pct, note) VALUES
        ('Andrew',  5.00, 8.25, 8.25, 8, NULL),
        ('Esteban', 5.00, 8.25, 8.25, 8, NULL),
        ('Chris',   7.00, 8.25, 8.25, 8, NULL),
        ('Joey',    5.00, 8.25, 8.25, 8, NULL),
        ('Council', 5.00, 8.25, 0,    8, 'No sales tax')
    `);
    console.log('  seeded 5 payout supplier presets');
  }
}


const { rows: [{ count }] } = await sql(`SELECT count(*)::int AS count FROM users`);
const { rows: [{ b }] } = await sql(`SELECT count(*)::int AS b FROM batches`);
const { rows: [{ po }] } = await sql(`SELECT count(*)::int AS po FROM purchase_orders`);
console.log(`✓ Tables ready. users: ${count}, batches: ${b}, purchase_orders: ${po}`);
await pool.end();
