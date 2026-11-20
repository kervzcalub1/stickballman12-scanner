// Where does each marketplace's OWN order number sit on its Shopify order — and can Shopify
// find an order by it?
//
//   node scripts/probe-shopify-order-numbers.mjs                 # last 3 days, every channel
//   node scripts/probe-shopify-order-numbers.mjs --days 7
//   node scripts/probe-shopify-order-numbers.mjs --find 206557037 --find 12-34567-89012
//                                   # numbers read off real labels: which search finds them?
//
// Why: the Order Cancellations bot (docs/context/cancellations.md) has to know the PLATFORM
// of a photographed label. Today the floor names it (/alias …) or taps a button. Shopify
// holds almost every channel's orders with the channel attached (docs/context/shopify.md),
// so the number on the label could name the platform by itself — IF that number is on the
// Shopify order somewhere we can search. This prints, per channel:
//   1. a few recent orders with every field such a number could be in (name, source
//      identifier, PO number, note, tags, custom attributes);
//   2. for each of those values, whether a Shopify order search on it finds THAT order.
// With --find it runs the same searches on numbers you type in off real labels.
//
// READ-ONLY. Nothing is written to Shopify or to our database. No customer names or
// addresses are requested; an order note is printed cut to 100 characters.
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
// The page gap of the eBay sync is fine here too: a second between calls.
const { gqlPaced, shopifyConfigured } = await import('../api/_lib/shopify.js');

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const DAYS = Math.max(1, Math.min(30, Number(arg('--days', 3)) || 3));
const SAMPLES = Math.max(1, Math.min(10, Number(arg('--samples', 3)) || 3));
const MAX_PAGES = Math.max(1, Math.min(40, Number(arg('--pages', 15)) || 15));
const FIND = args.flatMap((a, i) => (a === '--find' && args[i + 1] ? [args[i + 1]] : []));

if (!shopifyConfigured()) {
  console.error(bad('Shopify is not configured here: set SHOPIFY_STORE_DOMAIN and a token (or client id + secret) in .env.'));
  process.exit(1);
}

// Everything a connector app could have put the marketplace's number in. Line items: the
// first two only — enough to see the title shape and any per-line attribute.
const FIELDS = `
  id name createdAt sourceName sourceIdentifier poNumber note tags
  customAttributes { key value }
  app { name }
  channelInformation { channelDefinition { channelName handle } }
  lineItems(first: 2) { edges { node { title variantTitle sku customAttributes { key value } } } }
`;
const LIST = `query ProbeOrders($q: String!, $after: String) {
  orders(first: 100, query: $q, sortKey: CREATED_AT, reverse: true, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { ${FIELDS} } }
  }
}`;
const SEARCH = `query ProbeSearch($q: String!) {
  orders(first: 5, query: $q) { edges { node { ${FIELDS} } } }
}`;

const channelOf = (o) => o.channelInformation?.channelDefinition?.channelName || (o.app?.name ? `app: ${o.app.name}` : '(no channel)');
const fail = (r, what) => {
  const why = r.unauthorized ? 'Shopify rejected the token' : r.denied ? 'the token lacks a scope (read_orders)' : (r.errors || []).map((e) => e.message).join(' | ') || `HTTP ${r.status}`;
  console.error(bad(`\n${what} failed: ${why}`));
  process.exit(1);
};
const cut = (v, n = 100) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

// ── 1. Recent orders, grouped by channel ────────────────────────────────────────────
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
console.log(`\n${bold('Shopify order numbers per channel')} · last ${DAYS} day${DAYS === 1 ? '' : 's'} · read-only`);
const byChannel = new Map();
let after = null; let total = 0; let pages = 0;
do {
  const r = await gqlPaced(LIST, { q: `created_at:>='${since}'`, after });
  if (!r.ok) fail(r, 'Reading recent orders');
  const conn = r.data.orders;
  for (const { node } of conn.edges) {
    const k = channelOf(node);
    if (!byChannel.has(k)) byChannel.set(k, []);
    byChannel.get(k).push(node);
    total += 1;
  }
  after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  pages += 1;
  process.stdout.write(dim(`\r  read ${total} orders…`));
} while (after && pages < MAX_PAGES);
console.log(dim(`\r  read ${total} orders in ${pages} page${pages === 1 ? '' : 's'}${after ? ` (stopped at --pages ${MAX_PAGES}; older orders in the window were not read)` : ''}.`));

const channels = [...byChannel.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`\n${bold('1. Channels')}`);
for (const [k, list] of channels) console.log(`  ${String(list.length).padStart(5)}  ${k}`);

// The values on an order that could be "the number on the label".
function candidates(o) {
  const out = [];
  const push = (field, value) => { const v = String(value ?? '').trim(); if (v) out.push({ field, value: v }); };
  push('name', o.name);
  push('sourceIdentifier', o.sourceIdentifier);
  push('poNumber', o.poNumber);
  for (const a of o.customAttributes || []) push(`customAttributes.${a.key}`, a.value);
  for (const { node } of o.lineItems?.edges || []) for (const a of node.customAttributes || []) push(`lineItem.customAttributes.${a.key}`, a.value);
  return out;
}
// The ways to ask Shopify for an order by a number. A bare term is Shopify's "default
// search" (name, and whatever else it indexes); the rest are named filters.
const searchesFor = (v) => {
  const bare = v.replace(/^#/, '');
  return [
    ['name:', `name:${bare}`],
    ['name:#', `name:#${bare}`],
    ['bare term', bare],
    ['"quoted"', `"${bare}"`],
    ['po_number:', `po_number:${bare}`],
    ['source_identifier:', `source_identifier:${bare}`],
  ];
};
async function trySearches(value, wantId = null) {
  const hits = [];
  for (const [label, q] of searchesFor(value)) {
    const r = await gqlPaced(SEARCH, { q });
    if (!r.ok) { hits.push({ label, q, error: (r.errors || []).map((e) => e.message).join(' | ') || `HTTP ${r.status}` }); continue; }
    const found = r.data.orders.edges.map((e) => e.node);
    hits.push({ label, q, found, exact: wantId ? found.length === 1 && found[0].id === wantId : null, has: wantId ? found.some((f) => f.id === wantId) : null });
  }
  return hits;
}
const verdict = (h) => {
  if (h.error) return bad(`error (${cut(h.error, 60)})`);
  if (!h.found.length) return dim('nothing');
  if (h.exact) return ok('finds exactly this order');
  if (h.has) return `finds it among ${h.found.length}`;
  return bad(`finds ${h.found.length} OTHER order${h.found.length === 1 ? '' : 's'} (filter ignored?)`);
};

console.log(`\n${bold('2. What is on the order, and which search finds it')}`);
const summary = [];
for (const [k, list] of channels) {
  console.log(`\n${bold(k)} ${dim(`· ${list.length} orders · showing ${Math.min(SAMPLES, list.length)}`)}`);
  const tally = new Map();   // `${field} via ${search}` → how many samples it found exactly
  const shown = list.slice(0, SAMPLES);
  for (const o of shown) {
    const line = o.lineItems?.edges?.[0]?.node;
    console.log(`  ${bold(o.name)}  ${dim(o.createdAt)}  ${dim(o.id.split('/').pop())}`);
    console.log(`    sourceName=${o.sourceName ?? '—'}  sourceIdentifier=${o.sourceIdentifier ?? '—'}  poNumber=${o.poNumber ?? '—'}  app=${o.app?.name ?? '—'}`);
    if (o.tags?.length) console.log(`    tags: ${cut(o.tags.join(', '))}`);
    if (o.note) console.log(`    note: ${cut(o.note)}`);
    for (const a of o.customAttributes || []) console.log(`    attr ${a.key} = ${cut(a.value, 80)}`);
    if (line) console.log(`    line: ${cut(line.title, 70)}${line.variantTitle ? ` · ${line.variantTitle}` : ''}${line.sku ? ` · sku ${line.sku}` : ''}`);
    for (const a of line?.customAttributes || []) console.log(`    line attr ${a.key} = ${cut(a.value, 80)}`);
    // Only values that look like an order number: at least 6 digits in them.
    for (const c of candidates(o).filter((x) => (x.value.match(/\d/g) || []).length >= 6 && x.value.length <= 60)) {
      const hits = await trySearches(c.value, o.id);
      console.log(`    ${dim('search')} ${c.field} = ${c.value}`);
      for (const h of hits) {
        console.log(`      ${h.label.padEnd(20)} ${verdict(h)}`);
        if (h.exact) tally.set(`${c.field} via ${h.label}`, (tally.get(`${c.field} via ${h.label}`) || 0) + 1);
      }
    }
  }
  const works = [...tally.entries()].filter(([, n]) => n === shown.length).map(([w]) => w);
  summary.push([k, list.length, works]);
}

console.log(`\n${bold('3. Summary — a search that found EXACTLY the right order on every sample')}`);
for (const [k, n, works] of summary) {
  console.log(`  ${k} ${dim(`(${n})`)}: ${works.length ? ok(works.join(' · ')) : bad('none — the number is not searchable from these fields')}`);
}
console.log(dim('\n  This says which Shopify FIELD is searchable. Whether that field is the number PRINTED ON THE LABEL'));
console.log(dim('  is the other half: compare a few names above with real labels, or run with --find <number off a label>.'));

// ── 4. Numbers typed in off real labels ─────────────────────────────────────────────
if (FIND.length) {
  console.log(`\n${bold('4. Numbers off real labels')}`);
  for (const n of FIND) {
    console.log(`\n  ${bold(n)}`);
    for (const h of await trySearches(n)) {
      if (h.error) { console.log(`    ${h.label.padEnd(20)} ${bad(`error (${cut(h.error, 60)})`)}`); continue; }
      const what = h.found.length
        ? h.found.map((f) => `${f.name} [${channelOf(f)}]`).join(', ')
        : dim('nothing');
      console.log(`    ${h.label.padEnd(20)} ${h.found.length === 1 ? ok(what) : what}`);
    }
  }
}
console.log('');
