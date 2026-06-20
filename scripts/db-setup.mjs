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
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS added_to_intel_inv BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS synced_alias       BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS synced_stockx      BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS synced_shopify     BOOLEAN NOT NULL DEFAULT false`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS ph_note            TEXT`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS last_edit_by       TEXT`);
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS last_edit_at       TIMESTAMPTZ`);
// Gender/age group (Men | Women | Youth | Toddler | Unisex) — from the product
// lookup (Alias gender, else derived from StockX size suffix) for store listing.
await sql(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gender             TEXT`);

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

const { rows: [{ count }] } = await sql(`SELECT count(*)::int AS count FROM users`);
const { rows: [{ b }] } = await sql(`SELECT count(*)::int AS b FROM batches`);
console.log(`✓ Tables ready. users: ${count}, batches: ${b}`);
await pool.end();
