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

const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
console.log(`✓ Tables ready. users rows: ${count}`);
