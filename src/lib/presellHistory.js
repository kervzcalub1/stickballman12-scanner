// Pre-sell HISTORY (owner, 2026-11-13: "when did I enter a pre-sale and what kind of shoes and
// sizes?") — pure, shared by the server read and the screen. docs/context/presell-listings.md.
//
// Two sources, one shape (a "run" = one time someone entered pairs):
//   • presell_entries — written when the pairs are entered (List new, Stock → Pairs… raise).
//     One paste can be several create calls; they share a run_id and show as ONE run.
//   • presell_listings — for everything entered BEFORE the history table existed, rebuilt
//     from the listing rows: one person's listings with no gap over REBUILD_GAP_MIN between
//     them are one run, a size's pairs = the most listings it got on either platform.
// Run: { key, at, by, kind, source, activate, in_transit, transit_note, expected_on, supplier,
//        po_code, pairs, shoes:[{ sku, name, image, sizes:[{ size, qty, from?, to?, shelf,
//        alias?:{ min, max, created, failed }, stockx?:{…} }] }] }  (prices in cents)
export const REBUILD_GAP_MIN = 15;
const PLATS = ['alias', 'stockx'];
const sizeNum = (s) => { const m = String(s || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : Infinity; };
const ms = (t) => new Date(t).getTime();

function addPrice(slot, cents, created = 1, failed = 0) {
  const c = Number(cents);
  if (Number.isFinite(c) && c > 0) { slot.min = slot.min == null ? c : Math.min(slot.min, c); slot.max = slot.max == null ? c : Math.max(slot.max, c); }
  slot.created += created; slot.failed += failed;
}
// shoes: Map sku → { sku, name, image, sizes: Map size → line }
function finish(run, shoes) {
  run.shoes = [...shoes.values()].map((s) => ({ ...s, sizes: [...s.sizes.values()].sort((a, b) => sizeNum(a.size) - sizeNum(b.size)) }));
  run.pairs = run.shoes.reduce((n, s) => n + s.sizes.reduce((m, z) => m + (Number(z.qty) || 0), 0), 0);
  return run;
}
function sizeLine(shoes, l) {
  const sku = String(l.sku || '').toUpperCase();
  if (!shoes.has(sku)) shoes.set(sku, { sku, name: l.name || null, image: l.image || null, sizes: new Map() });
  const shoe = shoes.get(sku);
  if (!shoe.name && l.name) shoe.name = l.name;
  if (!shoe.image && l.image) shoe.image = l.image;
  const k = String(l.size);
  if (!shoe.sizes.has(k)) shoe.sizes.set(k, { size: k, qty: 0, shelf: null });
  return shoe.sizes.get(k);
}

// presell_entries rows (oldest or newest first, either) → runs.
export function runsFromEntries(entries = []) {
  const runs = new Map();
  for (const e of [...entries].sort((a, b) => ms(a.created_at) - ms(b.created_at))) {
    const key = e.run_id ? `r:${e.run_id}` : `e:${e.id}`;
    if (!runs.has(key)) {
      runs.set(key, { run: { key, at: e.created_at, by: e.created_by || null, kind: e.kind || 'new', source: 'entry', activate: e.activate ?? null,
        in_transit: !!e.in_transit, transit_note: e.transit_note || null, expected_on: e.expected_on || null, supplier: e.supplier || null,
        po_code: e.po_code || null }, shoes: new Map() });
    }
    const { run, shoes } = runs.get(key);
    for (const l of Array.isArray(e.lines) ? e.lines : []) {
      const z = sizeLine(shoes, l);
      z.qty += Number(l.qty) || 0;
      if (l.shelf != null && z.shelf == null) z.shelf = Number(l.shelf);
      if (l.from != null) { z.from = z.from ?? Number(l.from); z.to = Number(l.to); }
      for (const p of PLATS) {
        if (!l[p]) continue;
        z[p] = z[p] || { min: null, max: null, created: 0, failed: 0 };
        addPrice(z[p], l[p].price_cents, Number(l[p].created) || 0, Number(l[p].failed) || 0);
      }
    }
  }
  return [...runs.values()].map(({ run, shoes }) => finish(run, shoes));
}

// presell_listings rows joined to their stock row → runs (before the history table).
export function runsFromListings(rows = [], gapMin = REBUILD_GAP_MIN) {
  const sorted = [...rows].sort((a, b) => String(a.created_by || '').localeCompare(String(b.created_by || '')) || ms(a.created_at) - ms(b.created_at));
  const out = [];
  let cur = null; let last = 0; let counts = null;
  const close = () => {
    if (!cur) return;
    for (const [z, c] of counts) z.qty = Math.max(c.alias || 0, c.stockx || 0);
    out.push(finish(cur.run, cur.shoes));
  };
  for (const l of sorted) {
    const t = ms(l.created_at);
    if (!cur || (cur.run.by || '') !== (l.created_by || '') || t - last > gapMin * 60_000) {
      close();
      cur = { run: { key: `l:${l.id}`, at: l.created_at, by: l.created_by || null, kind: 'new', source: 'rebuilt', activate: null,
        in_transit: !!l.in_transit, transit_note: l.transit_note || null, expected_on: l.expected_on || null, supplier: l.supplier || null,
        po_code: l.po_code || null }, shoes: new Map() };
      counts = new Map();
    }
    last = t;
    const z = sizeLine(cur.shoes, l);
    if (l.shelf_price != null && z.shelf == null) z.shelf = Number(l.shelf_price);
    if (PLATS.includes(l.platform)) {
      z[l.platform] = z[l.platform] || { min: null, max: null, created: 0, failed: 0 };
      addPrice(z[l.platform], l.price_cents);
      const c = counts.get(z) || {};
      c[l.platform] = (c[l.platform] || 0) + 1;
      counts.set(z, c);
    }
  }
  close();
  return out;
}

// Both sources, newest run first.
export function presellHistory(entries, listings, gapMin) {
  return [...runsFromEntries(entries), ...runsFromListings(listings, gapMin)].sort((a, b) => ms(b.at) - ms(a.at));
}

// "8 × 2 · 9 × 3" for a shoe's sizes.
export const sizesText = (sizes) => sizes.map((z) => `${z.size} × ${z.qty}`).join(' · ');
