// One-off backfill: fill missing UPC / colorway on existing items from the
// product API (KicksDB) by SKU. Safe to re-run — only touches rows that are
// still missing the field. Pass --dry to preview without writing.
//
//   node scripts/backfill-upc.mjs          # apply
//   node scripts/backfill-upc.mjs --dry    # preview only
//
// Note on UPCs: a style (SKU) has a DIFFERENT UPC per size. This matches each
// item to its size's variant and uses that variant's UPC/GTIN when the API
// provides one. Colorway is style-level, so it always backfills when found.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

if (!process.env.DATABASE_URL || !process.env.KICKSDB_KEY) {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      let v = m[2]; if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}
const DRY = process.argv.includes('--dry');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }
if (!process.env.KICKSDB_KEY) { console.error('KICKSDB_KEY not set.'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /\bsslmode=require\b|\.neon\.tech/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});
const KICKS = 'https://api.kicks.dev/v3/stockx/products';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s || '').replace(/\D/g, '');
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

// Pull any UPC/GTIN-looking value off a variant (KicksDB shapes vary).
function variantUpc(v) {
  const cands = [v?.gtin, v?.upc, v?.barcode, v?.identifiers?.gtin, v?.identifiers?.upc, v?.identifiers?.gtin13];
  for (const c of cands) { const d = digits(c); if (d.length >= 8) return d; }
  return null;
}

// Same key list + failover as api/_lib/kicksdb.js: a key that has hit its plan limit is
// deactivated and answers 401, so walk to the backup instead of aborting the whole backfill.
const KICKS_KEYS = [...new Set([process.env.KICKSDB_KEY, process.env.KICKSDB_KEY_2].filter(Boolean))];
let keyIdx = 0;

async function fetchProduct(sku) {
  const url = `${KICKS}?query=${encodeURIComponent(sku)}&display[variants]=true&limit=1`;
  for (; keyIdx < KICKS_KEYS.length; keyIdx++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${KICKS_KEYS[keyIdx]}` } });
    if (r.ok) {
      const data = await r.json();
      return Array.isArray(data?.data) ? data.data[0] : null;
    }
    if (![401, 402, 403, 429].includes(r.status)) throw new Error(`KicksDB ${r.status}`);
    console.warn(`  key #${keyIdx + 1} rejected (HTTP ${r.status}) — switching to the next key.`);
  }
  throw new Error('KicksDB: every key is spent (401/429).');
}

const rows = (await pool.query(
  `SELECT id, sku, size, upc, colorway FROM items
   WHERE sku IS NOT NULL AND sku <> '' AND (upc IS NULL OR colorway IS NULL)
   ORDER BY sku`,
)).rows;

console.log(`${rows.length} item(s) need backfill${DRY ? ' (dry run)' : ''}.`);
const bySku = new Map();
for (const r of rows) { if (!bySku.has(r.sku)) bySku.set(r.sku, []); bySku.get(r.sku).push(r); }
console.log(`${bySku.size} distinct SKU(s) to look up.`);

let filledUpc = 0; let filledCw = 0; let lookups = 0; let misses = 0;
for (const [sku, items] of bySku) {
  let product;
  try { product = await fetchProduct(sku); lookups++; }
  catch (e) { console.warn(`  ! ${sku}: ${e.message}`); misses++; await sleep(400); continue; }
  if (!product) { console.warn(`  ? ${sku}: no product found`); misses++; await sleep(400); continue; }

  const colorway = (product.secondary_title || '').trim() || null;
  const variants = Array.isArray(product.variants) ? product.variants : [];
  for (const it of items) {
    const setUpc = (!it.upc && it.size)
      ? variantUpc(variants.find((v) => norm(v.size) === norm(it.size)))
      : null;
    const setCw = !it.colorway ? colorway : null;
    if (!setUpc && !setCw) continue;
    if (setUpc) filledUpc++;
    if (setCw) filledCw++;
    if (!DRY) {
      await pool.query(
        `UPDATE items SET upc = COALESCE($1, upc), colorway = COALESCE($2, colorway), updated_at = now() WHERE id = $3`,
        [setUpc, setCw, it.id],
      );
    }
  }
  await sleep(400); // be gentle with the API
}

console.log(`\nLookups: ${lookups} ok, ${misses} missed.`);
console.log(`${DRY ? 'Would fill' : 'Filled'}: ${filledUpc} UPC, ${filledCw} colorway.`);
if (filledUpc === 0 && rows.some((r) => !r.upc)) {
  console.log('Note: KicksDB did not expose per-size UPCs for these styles — colorway still backfilled. Newly received items capture the UPC directly at scan time.');
}
await pool.end();
