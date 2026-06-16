// One-off schema setup for the Neon Postgres database.
//   npm run db:setup
// Reads DATABASE_URL from .env (or the process env on a server) and creates the
// tables the app needs. Safe to re-run (IF NOT EXISTS).
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';

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

const sql = neon(process.env.DATABASE_URL);

console.log('Creating tables…');

await sql`
  CREATE TABLE IF NOT EXISTS users (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT        NOT NULL,
    username    TEXT        NOT NULL UNIQUE,            -- stored lowercased
    pass_hash   TEXT        NOT NULL,
    role        TEXT        NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
    status      TEXT        NOT NULL DEFAULT 'pending'  CHECK (status IN ('pending','approved','rejected')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS login_attempts (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username   TEXT,
    ip         TEXT,
    success    BOOLEAN     NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

await sql`CREATE INDEX IF NOT EXISTS login_attempts_username_idx ON login_attempts (username, created_at)`;
await sql`CREATE INDEX IF NOT EXISTS login_attempts_ip_idx       ON login_attempts (ip, created_at)`;

// Distributed mutex (single atomic SQL upsert per acquire) — used to serialize
// the rapid-scan read/modify/write so concurrent scans of the same SKU+size
// can't lose a quantity increment.
await sql`
  CREATE TABLE IF NOT EXISTS locks (
    key          TEXT PRIMARY KEY,
    locked_until TIMESTAMPTZ NOT NULL
  )
`;

/* ---- v4: inventory (batches, items, history, issues) ---- */

// Sequences for human-readable codes (atomic — no races).
await sql`CREATE SEQUENCE IF NOT EXISTS batch_seq START 100001`;
await sql`CREATE SEQUENCE IF NOT EXISTS vin_seq   START 1`; // VINs: SBM-<YYMMDD>-000001

await sql`
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
`;

await sql`
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
    status      TEXT NOT NULL DEFAULT 'in_stock',
    notes       TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS items_batch_idx ON items (batch_id)`;
await sql`CREATE INDEX IF NOT EXISTS items_sku_idx   ON items (sku)`;
await sql`CREATE INDEX IF NOT EXISTS items_created_idx ON items (created_at)`;

await sql`
  CREATE TABLE IF NOT EXISTS item_events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id     BIGINT REFERENCES items(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,   -- 'received' | 'status_change' | 'issue' | 'note' | 'moved' | 'sold'
    details     JSONB,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS item_events_item_idx ON item_events (item_id, created_at)`;

await sql`
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
`;

// Future (Phase 4) — profit tracking. Schema now, UI later.
await sql`
  CREATE TABLE IF NOT EXISTS sales (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id     BIGINT UNIQUE REFERENCES items(id) ON DELETE CASCADE,
    sale_price  NUMERIC(12,2),
    fees        NUMERIC(12,2),
    sold_at     TIMESTAMPTZ,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
const [{ b }] = await sql`SELECT count(*)::int AS b FROM batches`;
console.log(`✓ Tables ready. users: ${count}, batches: ${b}`);
