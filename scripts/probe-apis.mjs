// One-off: probe StockX / Alias / KicksDB to see which fields each returns for a
// shoe — especially the Alias `catalog_id` (product id) we need for GI fetching.
//   node scripts/probe-apis.mjs [SKU] [UPC]
// Loads .env the same way scripts/db-setup.mjs does. Read-only; prints a summary.
import fs from 'node:fs';
import path from 'node:path';

// --- load .env into process.env (only keys not already set) ---
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SKU = process.argv[2] || 'DD1391-100';   // Nike Dunk Low Panda (well-known)
let UPC = process.argv[3] || '';               // filled from KicksDB if omitted

const STOCKX_BASE = 'https://bypass-stock-x-host-railway-stock-x.up.railway.app';
const ALIAS_BASE = 'https://bypass-alias-host-railway-alias.up.railway.app';
const KICKS_BASE = 'https://api.kicks.dev/v3/stockx/products';

const show = (label, obj, keys) => {
  console.log(`\n  ${label}:`);
  if (!obj) { console.log('    (no result)'); return; }
  for (const k of keys) console.log(`    ${k.padEnd(16)} = ${JSON.stringify(obj[k])}`);
};

async function probeKicks() {
  console.log('\n=== KicksDB (SKU search) ===  sku=', SKU);
  const key = process.env.KICKSDB_KEY;
  if (!key) return console.log('  KICKSDB_KEY missing');
  const url = `${KICKS_BASE}?query=${encodeURIComponent(SKU)}&display[variants]=true&limit=1`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  console.log('  status', r.status);
  const data = await r.json().catch(() => null);
  const item = Array.isArray(data?.data) ? data.data[0] : null;
  if (item) console.log('  raw keys:', Object.keys(item).join(', '));
  show('fields', item, ['title', 'sku', 'upc', 'gtin', 'brand', 'secondary_title', 'id', 'catalog_id']);
  console.log('    variants        =', Array.isArray(item?.variants) ? item.variants.length : 0);
  const u = item?.upc || item?.gtin;
  if (u && !UPC) { UPC = String(u); console.log('  -> using UPC from KicksDB:', UPC); }
}

async function probeStockx() {
  console.log('\n=== StockX (UPC search) ===  upc=', UPC || '(none)');
  if (!UPC) return console.log('  no UPC to test');
  const r = await fetch(`${STOCKX_BASE}/stockx-upc-search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upc: UPC }),
  });
  console.log('  status', r.status);
  const data = await r.json().catch(() => null);
  const variant = data?.result?.data?.variants?.[0];
  const product = variant?.product;
  if (product) console.log('  product keys:', Object.keys(product).join(', '));
  show('product', product, ['title', 'styleId', 'sku', 'brand', 'secondaryTitle', 'id', 'catalogId', 'urlKey']);
  show('variant', variant, ['size']);
}

async function probeAlias() {
  console.log('\n=== Alias (UPC search) ===  upc=', UPC || '(none)');
  if (!UPC) return console.log('  no UPC to test');
  const email = process.env.ALIAS_EMAIL, password = process.env.ALIAS_PASSWORD;
  if (!email || !password) return console.log('  ALIAS creds missing');
  const lr = await fetch(`${ALIAS_BASE}/alias-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const ld = await lr.json().catch(() => null);
  const token = ld?.auth_token?.access_token;
  console.log('  login status', lr.status, '· token', token ? 'ok' : 'MISSING');
  if (!token) return;
  const r = await fetch(`${ALIAS_BASE}/alias-upc-search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, authorization_token: token, upc: UPC }),
  });
  console.log('  status', r.status);
  const data = await r.json().catch(() => null);
  const product = data?.result?.results?.[0]?.product;
  if (product) console.log('  product keys:', Object.keys(product).join(', '));
  show('product', product, ['id', 'catalog_id', 'name', 'nickname', 'sku', 'brand', 'colorway', 'gender', 'release_date']);
  console.log('    size_options    =', Array.isArray(product?.size_options) ? product.size_options.length : 0);

  // If we have a catalog_id, try the official pricing_insights endpoint for GI.
  const catalogId = product?.id ?? product?.catalog_id;
  if (catalogId) {
    const size = (product?.size_options?.[0]?.name) || (product?.size_options?.[0]?.presentation) || '9';
    const qs = new URLSearchParams({ catalog_id: String(catalogId), size: String(size), product_condition: 'PRODUCT_CONDITION_NEW', packaging_condition: 'PACKAGING_CONDITION_GOOD_CONDITION' });
    const pr = await fetch(`https://api.alias.org/api/v1/pricing_insights/availability?${qs}`, {
      headers: { accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    console.log(`\n=== Alias pricing_insights (official api.alias.org) ===  catalog_id=${catalogId} size=${size}`);
    console.log('  status', pr.status);
    const pd = await pr.json().catch(() => null);
    console.log('  body:', JSON.stringify(pd));
  }
}

(async () => {
  try { await probeKicks(); } catch (e) { console.log('  KicksDB error:', e.message); }
  try { await probeStockx(); } catch (e) { console.log('  StockX error:', e.message); }
  try { await probeAlias(); } catch (e) { console.log('  Alias error:', e.message); }
  console.log('\nDone.');
})();
