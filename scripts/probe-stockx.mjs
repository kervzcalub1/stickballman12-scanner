// Verify the StockX Public API credentials, and PRINT THE RAW SHAPES.
//   node scripts/probe-stockx.mjs [SKU] [SIZE]
//   node scripts/probe-stockx.mjs DD1391-100 10 --raw
//
// Why this exists: `api/_lib/stockx.js` reads the field names straight out of StockX's
// OpenAPI spec (developer.stockx.com/swagger.json), but a spec is a promise, not a
// response. This walks the whole chain — token → search → variants → market data — and
// says which link broke, so a failure is one line to read instead of a blank column on
// a buy screen. `--raw` prints the untouched JSON if the shapes ever drift.
//
// Read-only: four GETs at most, nothing is written anywhere.
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

const SKU = process.argv[2] || 'DD1391-100';
const SIZE = process.argv[3] || '10';
const RAW = process.argv.includes('--raw');

const {
  stockxConfigured, stockxAccessToken, stockxProductBySku,
  stockxVariants, stockxVariantMarket, STOCKX_BASE,
} = await import('../api/_lib/stockx.js');

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Never print a credential, not even partially — this output gets pasted into chats.
const present = (k) => (process.env[k] ? ok('set') : bad('MISSING'));

console.log(`\nStockX Public API probe · ${STOCKX_BASE}`);
console.log(`  STOCKX_API_KEY        ${present('STOCKX_API_KEY')}`);
console.log(`  STOCKX_CLIENT_ID      ${present('STOCKX_CLIENT_ID')}`);
console.log(`  STOCKX_CLIENT_SECRET  ${present('STOCKX_CLIENT_SECRET')}`);
console.log(`  STOCKX_REFRESH_TOKEN  ${present('STOCKX_REFRESH_TOKEN')}`);

if (!stockxConfigured()) {
  console.log(bad('\nNot configured — fill the four keys above in .env (see .env.example).\n'));
  process.exit(1);
}

try {
  console.log('\n1. Token exchange (refresh_token → access token)');
  const t = await stockxAccessToken();
  console.log(`   ${ok('OK')} ${dim(`access token received (${String(t).length} chars, not printed)`)}`);
} catch (e) {
  console.log(`   ${bad('FAILED')} ${e.message}`);
  console.log(dim('   A 401/invalid_grant here means the refresh token is revoked or expired —'));
  console.log(dim('   redo the browser authorization step in the portal and re-set STOCKX_REFRESH_TOKEN.\n'));
  process.exit(1);
}

console.log(`\n2. Catalogue search for ${SKU}`);
const product = await stockxProductBySku(SKU);
if (!product) {
  console.log(`   ${bad('no product')} — the search returned nothing usable. Re-run with --raw.`);
  process.exit(1);
}
console.log(`   ${product.exact ? ok('exact style match') : bad('INEXACT — matched a different style')}`);
console.log(`   id      ${product.id}`);
console.log(`   styleId ${product.styleId}`);
console.log(`   title   ${product.title}`);
if (!product.id) {
  console.log(bad('\n   No `productId` on the search hit — the response has drifted from the spec.'));
  console.log(bad('   Re-run with --raw and fix the extractor in api/_lib/stockx.js.\n'));
}

console.log('\n3. Variants (sizes)');
const variants = await stockxVariants(product.id);
console.log(`   ${variants.length ? ok(`${variants.length} variants`) : bad('none')}`);
console.log(`   ${dim(variants.slice(0, 12).map((v) => `${v.size || '?'}`).join('  '))}`);
const unnamed = variants.filter((v) => !v.size).length;
if (unnamed) console.log(bad(`   ${unnamed} variants came back with NO size — neither variantValue nor a US size-chart row.`));

const variant = variants.find((v) => String(v.size) === String(SIZE))
  || variants.find((v) => Number(v.size) === Number(SIZE));
if (!variant) {
  console.log(bad(`\n   Size ${SIZE} not found among the variants. Pick one from the list above.\n`));
  process.exit(1);
}

console.log(`\n4. Market data · size ${SIZE} (variant ${variant.id})`);
const market = await stockxVariantMarket(product.id, variant.id);
if (!market) {
  console.log(bad('   nothing came back — re-run with --raw.'));
} else {
  const show = (k, v) => console.log(`   ${k.padEnd(12)} ${v == null ? dim('—') : ok(`$${v}`)}`);
  show('lowest_ask', market.lowest_ask);
  show('highest_bid', market.highest_bid);
  show('earn_more', market.earn_more);   // no last-sale field exists in the spec
  show('sell_faster', market.sell_faster);
  if (market.lowest_ask == null && market.highest_bid == null) {
    console.log(bad('\n   Both sides of the book read null. Either this size genuinely has no market,'));
    console.log(bad('   or the amount fields are named something we don\'t read. Re-run with --raw.'));
  }
}

if (RAW) {
  // The point of --raw: the untouched JSON, so field names can be read off directly.
  console.log('\n--- RAW ---');
  const token = await stockxAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'x-api-key': process.env.STOCKX_API_KEY, Accept: 'application/json' };
  const dump = async (label, url) => {
    const r = await fetch(url, { headers });
    const body = await r.text();
    console.log(`\n${label}  [${r.status}]\n${body.slice(0, 4000)}`);
  };
  await dump('search', `${STOCKX_BASE}/catalog/search?query=${encodeURIComponent(SKU)}&pageSize=3`);
  if (product.id) {
    await dump('variants', `${STOCKX_BASE}/catalog/products/${product.id}/variants`);
    await dump('market-data', `${STOCKX_BASE}/catalog/products/${product.id}/variants/${variant.id}/market-data?currencyCode=USD&country=US`);
  }
}
console.log('');
