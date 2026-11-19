// Alias Cross-Listing — the rules the page and the server share
// (docs/context/alias-cross-listing.md). PURE.
//
// One physical pair is listed on Alias under several SKUs that are the same shoe. Per size
// there is ONE count of pairs (the pool); every SKU of the group may hold at most
// `qty − sold` open listings for that size. A sale on any SKU lowers that for all of them.

export const ALIAS_FEE = 0.099;   // the default Alias commission the estimate uses (pre-sell uses the same)
export const MAX_SKUS = 8;        // SKUs in one group
export const MAX_PAIRS = 50;      // pairs of one size
export const MAX_NEW_LISTINGS = 120;   // Alias listings one request may create

export const pairsLeft = (pool) => Math.max(0, Number(pool?.qty || 0) - Number(pool?.sold || 0));

// A style code as Alias prints it ("HF3063 002") → ours ("HF3063-002").
export const skuText = (s) => String(s || '').trim().replace(/\s+/g, '-').toUpperCase();

// Size labels in shoe order: 3.5, 4 … 10, 10.5; anything without a number last.
const num = (s) => { const m = String(s).match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : Infinity; };
export const bySize = (a, b) => num(a) - num(b) || String(a).localeCompare(String(b));

/**
 * Which open listings must come down so no SKU holds more than the pairs left.
 * `open` = the pool's live/off listings, oldest first. The NEWEST extras go.
 */
export function takeDownPlan(left, open) {
  const by = new Map();
  for (const l of open) { const k = Number(l.group_sku_id); if (!by.has(k)) by.set(k, []); by.get(k).push(l); }
  const out = [];
  for (const mine of by.values()) out.push(...mine.slice(Math.max(0, left)));
  return out;
}

/** How many more listings a SKU may get for a size. */
export const roomFor = (pool, open, groupSkuId) =>
  Math.max(0, pairsLeft(pool) - open.filter((l) => Number(l.group_sku_id) === Number(groupSkuId)).length);

/** Dollars typed → whole-dollar cents, or NaN. Alias prices are whole dollars. */
export function priceCents(v) {
  if (v === '' || v == null) return NaN;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 100000 ? Math.round(n) * 100 : NaN;
}
/** A cost per pair typed → dollars with cents, null when blank, NaN when not a cost. */
export function costValue(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) / 100 : NaN;
}

/** Payout (Alias's own when it gave one, else price − the default fee) and net = payout − cost. */
export function saleMoney({ price_cents, payout_cents, unit_cost }) {
  const price = price_cents != null ? Number(price_cents) / 100 : null;
  const estimated = payout_cents == null;
  const payout = !estimated ? Number(payout_cents) / 100 : price != null ? Math.round(price * (1 - ALIAS_FEE) * 100) / 100 : null;
  const cost = unit_cost == null || unit_cost === '' ? null : Number(unit_cost);
  const net = payout != null && cost != null ? Math.round((payout - cost) * 100) / 100 : null;
  return { price, payout, estimated, cost, net };
}

const usd = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`);
export const money = usd;

/** The Telegram post for one sale. Lines are strings or { b, t } (bold label + text). */
export function saleLines({ groupName, sku, skuName, size, orderId, price_cents, payout_cents, unit_cost, pool, removed = [], others = [] }) {
  const m = saleMoney({ price_cents, payout_cents, unit_cost });
  const RULE = '━━━━━━━━━━━━━━━━';
  const down = removed.filter((r) => r.ok);
  const stuck = removed.filter((r) => !r.ok);
  const left = pairsLeft(pool);
  return [
    { b: '🔀 CROSS-LISTING SALE — Alias' },
    '',
    { b: skuName || groupName || 'Cross-listed pair' },
    `Sold as ${sku || '?'} · size ${size || '?'}`,
    RULE,
    { b: '💵 MONEY' },
    { b: 'Price:', t: ` ${usd(m.price)}` },
    { b: 'Payout:', t: ` ${usd(m.payout)}${m.estimated ? ' (est. — fee taken off the price)' : ''}` },
    { b: 'Cost:', t: m.cost != null ? ` ${usd(m.cost)}` : ' not entered' },
    ...(m.net != null ? [{ b: `${m.net < 0 ? '🔻' : '✅'} NET: ${m.net < 0 ? '−' : ''}${usd(Math.abs(m.net))}` }] : []),
    RULE,
    { b: '🧾 ORDER' },
    { b: 'Order:', t: ` ${orderId}` },
    { b: 'Shoe group:', t: ` ${groupName || '—'}` },
    { b: 'Pairs left:', t: ` ${left} of ${Number(pool?.qty || 0)} (size ${size})` },
    RULE,
    { b: '📦 SHIP IT AS THE SKU IT SOLD UNDER' },
    `Alias checks the pair against ${sku || 'that SKU'} — send the pair whose box label matches.`,
    ...(down.length ? [`Taken down on the other SKUs: ${down.map((r) => r.sku).join(', ')} (${down.length})`] : []),
    ...(others.length && !down.length && !stuck.length ? [`Other SKUs still listed: ${others.join(', ')}`] : []),
    ...(stuck.length ? [`⚠️ Could NOT take down ${stuck.length} listing(s) — take them down on Alias now: ${stuck.map((r) => `${r.sku}: ${r.error}`).join('; ')}`] : []),
  ];
}
