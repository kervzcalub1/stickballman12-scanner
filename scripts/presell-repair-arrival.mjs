// One-off repair (2026-10-11): an in-transit pre-sell shipment whose arrival was taken by the
// OLD rule ("any receive = everything arrived, delete every listing"). Re-counts the given
// batch BY THE PAIR (the new rule, src/lib/presellDetails.js arrivalSplit): for each size,
// the pairs received in that batch are the pairs arrived; they first cover pairs sold in
// transit before the receive (set aside), the rest are released to PH. The row goes back to
// "in transit" unless every pair has arrived. SETS the values (doesn't add), so running it
// twice is harmless. Dry run unless --apply.
//
//   node scripts/presell-repair-arrival.mjs --sku IQ5495-005 --batch B-101354           (dry run)
//   node scripts/presell-repair-arrival.mjs --sku IQ5495-005 --batch B-101354 --apply
//
// Then re-list what's short from Pre-sell Listings → Stock → ↺ Restore.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { arrivalSplit } from '../src/lib/presellDetails.js';

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
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const sku = String(arg('sku') || '').toUpperCase();
const batch = arg('batch');
const apply = process.argv.includes('--apply');
if (!sku || !batch || !process.env.DATABASE_URL) {
  console.error('Usage: node scripts/presell-repair-arrival.mjs --sku <SKU> --batch <BATCH_CODE> [--apply]   (DATABASE_URL required)');
  process.exit(1);
}
const DB_URL = process.env.DATABASE_URL;
const loose = /\bsslmode=require\b|\.neon\.tech|\brlwy\.net\b|\.railway\.app\b/.test(DB_URL);
const pool = new pg.Pool({ connectionString: DB_URL, ssl: loose ? { rejectUnauthorized: false } : undefined });

const { rows: stocks } = await pool.query(`SELECT * FROM presell_stock WHERE upper(sku) = $1 AND in_transit ORDER BY id`, [sku]);
if (!stocks.length) { console.error(`No in-transit pre-sell rows for ${sku}.`); process.exit(1); }
const { rows: got } = await pool.query(`
  SELECT regexp_replace(coalesce(i.size, ''), '[^0-9.]', '', 'g') AS sz, count(*)::int AS n, min(i.created_at) AS first_at
    FROM items i JOIN batches b ON b.id = i.batch_id
   WHERE b.batch_code = $1 AND upper(i.sku) = $2 GROUP BY 1`, [batch, sku]);
const bySize = new Map(got.map((r) => [r.sz, r]));

console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${sku}, batch ${batch}\n`);
console.log('size | qty | sold-before | arrived | set aside | to PH | still on the way | pre-sell can list');
let total = 0;
for (const s of stocks) {
  const r = bySize.get(String(s.size).replace(/[^0-9.]/g, ''));
  const n = r?.n || 0;
  const soldBefore = r ? Number((await pool.query(`SELECT count(*)::int AS c FROM presell_sales WHERE stock_id = $1 AND COALESCE(sold_at, created_at) < $2`, [s.id, r.first_at])).rows[0].c) : 0;
  const split = arrivalSplit({ qty: s.qty, sold: soldBefore, arrived_qty: 0, released_qty: 0 }, n);
  const can = Math.max(0, Number(s.qty) - Number(s.sold));
  total += can;
  console.log([s.size, s.qty, soldBefore, split.n, split.aside, split.release, Number(s.qty) - split.n, `${can} (until PH lists the ${split.release})`].join(' | '));
  if (!apply) continue;
  await pool.query(`
    UPDATE presell_stock SET arrived_qty = $2, released_qty = $3, arrived_at = CASE WHEN $4 THEN now() ELSE NULL END,
           arrived_batch = $5, updated_at = now() WHERE id = $1`, [s.id, split.n, split.release, split.full, n ? batch : null]);
  if (n) {
    await pool.query(`DELETE FROM presell_arrivals WHERE stock_id = $1 AND batch_code = $2`, [s.id, batch]);
    await pool.query(`INSERT INTO presell_arrivals (stock_id, batch_code, pairs, set_aside, released, note) VALUES ($1, $2, $3, $4, $5, 'repair: re-counted by the pair')`,
      [s.id, batch, split.n, split.aside, split.release]);
  }
}
console.log(`\nPre-sell can list ${total} pairs per platform in all.${apply ? ' Saved.' : ' Nothing saved — add --apply.'}`);
await pool.end();
