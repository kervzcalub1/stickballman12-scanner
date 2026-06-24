// One-off backfill: for existing items, populate the products catalog (from
// Alias) and the per-unit global indicator price (+ seed final price = GI×1.2).
//   node scripts/backfill-gi.mjs          # dry run (no writes)
//   node scripts/backfill-gi.mjs --apply  # write to DB
// Only fills items whose global_indicator IS NULL (never clobbers PH edits).
import fs from 'node:fs'; import path from 'node:path'; import pg from 'pg';

const envPath = path.join(process.cwd(), '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const APPLY = process.argv.includes('--apply');
const GI_MARKUP = 1.2;

const { aliasProductByUpc, aliasCatalogBySku, aliasGlobalIndicator } = await import('../api/_lib/alias.js');
const { upsertProduct } = await import('../api/_lib/db.js');

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// Items needing a GI: have a size, a upc OR sku, and no global_indicator yet.
const { rows: items } = await c.query(
  `SELECT id, vin, upc, size, sku FROM items
   WHERE size IS NOT NULL AND size <> '' AND global_indicator IS NULL
     AND (upc IS NOT NULL OR sku IS NOT NULL)
   ORDER BY upc NULLS LAST, sku, size`,
);
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · ${items.length} item(s) to consider\n`);

const catalogByKey = new Map(); // upc:/sku: -> catalog_id | null
const giByKey = new Map();      // catalog|size -> dollars | null
let filledItems = 0, catalogs = 0, skipped = 0;

// Resolve catalog_id from UPC (preferred) or SKU (official catalog search).
async function resolveCatalog(it) {
  const key = it.upc ? `upc:${it.upc}` : `sku:${it.sku}`;
  if (catalogByKey.has(key)) return catalogByKey.get(key);
  let p = null;
  if (it.upc) p = await aliasProductByUpc(it.upc);
  else if (it.sku) p = await aliasCatalogBySku(it.sku);
  if (p?.catalogId) {
    if (APPLY) await upsertProduct({ ...p, upc: it.upc || p.upc || null, sku: it.sku || p.sku, size: it.size });
    catalogs++;
    console.log(`  catalog  ${it.upc || it.sku} -> ${p.catalogId}  (${p.name})`);
  }
  catalogByKey.set(key, p?.catalogId || null);
  return p?.catalogId || null;
}

for (const it of items) {
  const catalogId = await resolveCatalog(it);
  if (!catalogId) { skipped++; continue; }

  const key = `${catalogId}|${it.size}`;
  if (!giByKey.has(key)) giByKey.set(key, await aliasGlobalIndicator({ catalogId, size: it.size }));
  const gi = giByKey.get(key);
  if (gi == null) { skipped++; console.log(`  skip     ${it.vin} size ${it.size}: no GI`); continue; }

  const price = Math.round(gi * GI_MARKUP * 100) / 100;
  if (APPLY) {
    await c.query(
      `UPDATE items SET global_indicator = $1, price = coalesce(price, $2), updated_at = now() WHERE id = $3`,
      [gi, price, it.id],
    );
  }
  filledItems++;
  console.log(`  fill     ${it.vin} size ${it.size}: GI $${gi.toFixed(2)} -> final $${price.toFixed(2)}`);
}

console.log(`\nDone. catalogs upserted: ${catalogs} · items filled: ${filledItems} · skipped: ${skipped}`);
if (!APPLY) console.log('(dry run — re-run with --apply to write)');
await c.end();
