// Reset INVENTORY DATA only (keeps user accounts + login throttle).
//   node scripts/db-reset.mjs
// Truncates batches/items/item_events/shipment_issues/sales and rewinds the
// VIN + batch counters to their start. DESTRUCTIVE and irreversible — it wipes
// all received/rescaled stock and history, but leaves users/locks intact.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

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
const count = async (t) => (await sql(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;

console.log('Resetting inventory data (accounts kept)…');
const before = {
  batches: await count('batches'), items: await count('items'),
  events: await count('item_events'), issues: await count('shipment_issues'),
  sales: await count('sales'), users: await count('users'),
};

// One statement: cascades cover the FK graph; RESTART IDENTITY rewinds the
// per-table id columns. The standalone VIN/batch sequences are reset separately.
await sql(`TRUNCATE TABLE item_events, items, shipment_issues, sales, batches RESTART IDENTITY CASCADE`);
await sql(`ALTER SEQUENCE batch_seq RESTART WITH 100001`);
await sql(`ALTER SEQUENCE vin_seq   RESTART WITH 1`);

console.log(`✓ Cleared: ${before.batches} batches, ${before.items} items, ${before.events} events, ${before.issues} issues, ${before.sales} sales.`);
console.log(`✓ Kept:    ${before.users} user account(s). VIN→1, batch→100001.`);
await pool.end();
