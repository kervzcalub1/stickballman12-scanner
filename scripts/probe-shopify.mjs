// Verify the Shopify connection end to end, and PRINT WHAT IT CAN ACTUALLY REACH.
//   node scripts/probe-shopify.mjs [SKU]
//
// A granted scope is a promise; a working call is a fact. This walks the whole chain —
// auth, sales window, channel attribution, style extraction, inventory — and says which
// link broke, so a failure is one line to read rather than a blank panel on a screen
// somebody is using to decide what to buy.
//
// Read-only. Nothing is written anywhere.
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const SKU = process.argv[2] || 'IO2463-102';
const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const token = process.env.SHOPIFY_ACCESS_TOKEN;

console.log(`\nShopify probe · ${domain || bad('no SHOPIFY_STORE_DOMAIN')}`);
console.log(`  SHOPIFY_ACCESS_TOKEN  ${token ? ok('set') : bad('MISSING — run scripts/shopify-auth.mjs')}`);
if (!domain || !token) process.exit(1);

const rest = async (p) => {
  const r = await fetch(`https://${domain}/admin/api/${process.env.SHOPIFY_API_VERSION || '2026-07'}${p}`,
    { headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' } });
  return { s: r.status, j: await r.json().catch(() => null) };
};

console.log('\n1. Granted scopes');
const sc = await fetch(`https://${domain}/admin/oauth/access_scopes.json`, { headers: { 'X-Shopify-Access-Token': token } });
const scopes = ((await sc.json().catch(() => null))?.access_scopes || []).map((x) => x.handle);
console.log(`   ${scopes.length ? ok(scopes.join(', ')) : bad('none returned')}`);
const need = ['read_orders', 'read_products', 'read_inventory'];
for (const n of need) {
  const has = scopes.includes(n) || (n === 'read_orders' && scopes.includes('read_all_orders'));
  console.log(`   ${has ? ok('✓') : bad('✗')} ${n}`);
}

console.log('\n2. How far back the sales feed reaches');
for (const days of [30, 60, 90, 180]) {
  const min = new Date(Date.now() - days * 864e5).toISOString();
  const max = new Date(Date.now() - (days - 5) * 864e5).toISOString();
  const a = await rest(`/orders.json?status=any&limit=1&created_at_min=${min}&created_at_max=${max}&fields=id,created_at`);
  const n = (a.j?.orders || []).length;
  console.log(`   ${String(days).padStart(3)}–${days - 5} days ago  ${n ? ok('reachable') : dim('empty')}`);
}

console.log('\n3. A week of sales, by channel');
const { shopifyTopSellers, shopifyVelocity, shopifyInventoryForSku } = await import('../api/_lib/shopify.js');
const top = await shopifyTopSellers({ days: 7, limit: 5 });
if (!top || top.error) {
  console.log(`   ${bad(top?.error || 'no result')}`);
} else {
  console.log(`   ${ok(`${top.orders} orders · ${top.units} units`)} ${dim(`(${top.unmatched_units} units had no style code in the title)`)}`);
  console.log(`   channels: ${Object.entries(top.channels).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' · ')}`);
  for (const s of top.styles) {
    console.log(`     ${String(s.sold).padStart(3)}  ${String(s.style_id).padEnd(13)} $${String(s.avg_price ?? '-').padEnd(7)} ${Object.entries(s.channels).map(([c, n]) => `${c} ${n}`).join(', ')}`);
  }
}

console.log(`\n4. One style: ${SKU}`);
const v = await shopifyVelocity(SKU, { days: 30 });
console.log(v?.error ? `   ${bad(v.error)}` : `   ${ok(`${v.sold} sold in ${v.days} days`)} · ${v.per_week}/week → ${bold(v.liquidity)} · ${Object.entries(v.channels || {}).map(([c, n]) => `${c} ${n}`).join(', ') || 'no channel data'}`);

console.log('\n5. Inventory');
const inv = await shopifyInventoryForSku(SKU);
if (inv?.permission) console.log(`   ${bad('not permitted')} ${dim(inv.permission)}`);
else if (inv?.error) console.log(`   ${bad(inv.error)}`);
else console.log(`   ${ok(`${inv.total} in stock`)} across ${inv.variants} variants · ${JSON.stringify(inv.sizes).slice(0, 160)}`);
console.log('');
