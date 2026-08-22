// Shopify — the single sales feed.
//
// Shopify is the AGGREGATOR here, not one channel among several: GOAT, StockX, TikTok,
// Kicks Crew and the online store all land as Shopify orders with the channel attached.
// That is why this replaced both the monthly CSV export (18,686 rows — it *was* this
// data) and the per-platform sales pulls: one feed, every channel, attributed.
//
// Three things that shape the code:
//
// 1. **The style ID is not in the `sku` field.** That field holds an internal code
//    ("10101157"); the style lives in the line-item TITLE, in one of four shapes —
//    "(FB2599-011)", "(CI1694-001 2024)", "- IF4396-103", or a bare "- JS3931".
//    `styleFromTitle` gets ~97% of them; the rest genuinely have no code in the title
//    and are counted as unmatched rather than quietly dropped.
//
// 2. **How far back depends on the SCOPE.** With plain `read_orders` Shopify serves the
//    last 60 days and silently returns nothing older (measured: 55–60 days back returns
//    rows, 70–75 does not). With `read_all_orders` the limit lifts — 180 days confirmed.
//    `MAX_WINDOW_DAYS` is our own cost bound on top of that, not Shopify's.
//
// 3. **Inventory needs its own scopes.** read_products / read_inventory are separate
//    grants from read_orders. When they're absent the call degrades to a clear
//    "not permitted" rather than an error or, worse, a zero — "none left" and "we can't
//    see it" are opposite answers, and only one of them sends someone to a shelf.
import { cacheGet, cacheSet } from './util.js';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const SALES_TTL = 30 * 60 * 1000;
const PAGE = 250;
const MAX_PAGES = 60;          // 15,000 orders — a stop, not a target
// A COST bound, not a permission one. With `read_all_orders` granted, Shopify will
// serve 180 days and more — but this store does ~1,400 orders a week, so a 180-day
// window is ~36,000 orders and 140+ pages. 90 days is the most that answers inside a
// chat turn. Raise it only alongside a smarter fetch (incremental, or persisted).
export const MAX_WINDOW_DAYS = 90;

export function shopifyConfigured() {
  return !!(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ACCESS_TOKEN);
}

const domain = () => String(process.env.SHOPIFY_STORE_DOMAIN || '')
  .replace(/^https?:\/\//, '').replace(/\/$/, '');

async function gql(query, variables) {
  const r = await fetch(`https://${domain()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await r.json().catch(() => null);
  // Shopify answers 200 with an `errors` array for permission problems, so a bare
  // `r.ok` check would read a refusal as success.
  const denied = (data?.errors || []).find((e) => /access denied|scope/i.test(e?.message || ''));
  return { ok: r.ok && !data?.errors, status: r.status, data: data?.data, errors: data?.errors, denied: !!denied };
}

/* ------------------------------------------------------------------ */
/* Style IDs out of line-item titles                                   */
/* ------------------------------------------------------------------ */

const DASHED = /\b([A-Z0-9]{4,10}[-–][A-Z0-9]{2,5})\b/gi;
const BARE = /^[A-Z]{1,3}[A-Z0-9]{3,9}$/i;
const hasDigit = (s) => /\d/.test(s);

// A style code is alphanumeric with at least one digit. The digit requirement is what
// keeps "Gel-Kayano" and "T-Shirt" out of the results.
export function styleFromTitle(title) {
  const t = String(title || '');
  const dashed = [...t.matchAll(DASHED)]
    .map((m) => m[1].replace('–', '-').toUpperCase())
    .filter((c) => hasDigit(c) && !/^\d{1,3}-\d{1,3}$/.test(c));
  if (dashed.length) return dashed[dashed.length - 1];
  const tail = t.match(/[-–]\s*([A-Z0-9]{4,10})\s*$/i);
  if (tail && hasDigit(tail[1])) return tail[1].toUpperCase();
  for (const m of [...t.matchAll(/\(([^()]{3,40})\)/g)].reverse()) {
    for (const w of m[1].trim().split(/\s+/)) if (BARE.test(w) && hasDigit(w)) return w.toUpperCase();
  }
  return null;
}

// Compare on alphanumerics only: the same shoe is written "HQ4309 610", "HQ4309-610"
// and "hq4309610" across the systems this app talks to.
const key = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ------------------------------------------------------------------ */
/* Sales                                                               */
/* ------------------------------------------------------------------ */

const ORDERS_QUERY = `query Sales($q: String!, $after: String) {
  orders(first: ${PAGE}, query: $q, sortKey: CREATED_AT, reverse: true, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      name createdAt
      channelInformation { channelDefinition { channelName } }
      app { name }
      lineItems(first: 10) { edges { node {
        title quantity variantTitle
        originalUnitPriceSet { shopMoney { amount } }
      } } }
    } }
  }
}`;

const estDaysAgo = (days) => {
  const est = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  est.setDate(est.getDate() - days);
  return est.toISOString().slice(0, 10);
};

/**
 * Every sale in the window, aggregated ONCE by style and cached. Both "what's selling"
 * and "how fast does this SKU move" read from the same aggregate, so a per-SKU question
 * costs nothing after the first fetch.
 */
export async function shopifySales({ days = 7 } = {}) {
  if (!shopifyConfigured()) return null;
  const d = Math.max(1, Math.min(MAX_WINDOW_DAYS, Number(days) || 7));
  const cacheKey = `shop:sales:${d}`;
  const hit = cacheGet(cacheKey);
  if (hit !== null) return hit;

  const byStyle = new Map();
  const byChannel = {};
  let orders = 0; let units = 0; let unmatched = 0;
  let after = null; let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = await gql(ORDERS_QUERY, { q: `created_at:>=${estDaysAgo(d)}`, after });
    if (!r.ok) return { error: r.denied ? 'not permitted' : 'Shopify sales lookup failed', days: d };
    const conn = r.data?.orders;
    for (const { node } of conn?.edges || []) {
      orders += 1;
      const channel = node.channelInformation?.channelDefinition?.channelName || node.app?.name || 'unknown';
      byChannel[channel] = (byChannel[channel] || 0) + 1;
      for (const li of node.lineItems?.edges || []) {
        const item = li.node;
        const qty = Number(item.quantity) || 1;
        units += qty;
        const style = styleFromTitle(item.title);
        if (!style) { unmatched += qty; continue; }
        const k = key(style);
        const e = byStyle.get(k) || { style_id: style, name: item.title, sold: 0, channels: {}, sizes: {}, prices: [], last_sold: null };
        e.sold += qty;
        e.channels[channel] = (e.channels[channel] || 0) + qty;
        if (item.variantTitle) e.sizes[item.variantTitle] = (e.sizes[item.variantTitle] || 0) + qty;
        const price = Number(item.originalUnitPriceSet?.shopMoney?.amount);
        if (Number.isFinite(price) && price > 0) e.prices.push(price);
        const day = String(node.createdAt).slice(0, 10);
        if (!e.last_sold || day > e.last_sold) e.last_sold = day;
        byStyle.set(k, e);
      }
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  const out = {
    days: d,
    orders,
    units,
    // Titles with no style code in them. Reported, never silently folded into a style.
    unmatched_units: unmatched,
    channels: byChannel,
    truncated,
    styles: [...byStyle.values()].map((e) => ({
      ...e,
      avg_price: e.prices.length ? Math.round((e.prices.reduce((a, b) => a + b, 0) / e.prices.length) * 100) / 100 : null,
      prices: undefined,
    })).sort((a, b) => b.sold - a.sold || a.style_id.localeCompare(b.style_id)),
    source: 'Shopify orders (all channels)',
  };
  cacheSet(cacheKey, out, SALES_TTL);
  return out;
}

/** What's selling, ranked, with the channel split that makes it actionable. */
export async function shopifyTopSellers({ days = 7, limit = 10 } = {}) {
  const all = await shopifySales({ days });
  if (!all || all.error) return all;
  const n = Math.max(1, Math.min(50, Number(limit) || 10));
  return { ...all, styles: all.styles.slice(0, n) };
}

/** How fast one style is selling, and where. */
export async function shopifyVelocity(sku, { days = 30 } = {}) {
  const all = await shopifySales({ days });
  if (!all || all.error) return all;
  const want = String(sku || '').split('/').map(key).filter(Boolean);
  const row = all.styles.find((s) => want.includes(key(s.style_id)));
  const sold = row?.sold || 0;
  const perWeek = sold / (all.days / 7);
  return {
    sku, days: all.days, sold, channels: row?.channels || {},
    sizes: row?.sizes || {}, last_sold: row?.last_sold || null, avg_price: row?.avg_price ?? null,
    per_week: Math.round(perWeek * 10) / 10,
    liquidity: perWeek >= 7 ? 'daily' : perWeek >= 1 ? 'weekly' : 'monthly',
    source: 'Shopify orders (all channels)',
  };
}

/* ------------------------------------------------------------------ */
/* Inventory — needs read_products / read_inventory                    */
/* ------------------------------------------------------------------ */

const INVENTORY_QUERY = `query Inv($q: String!) {
  productVariants(first: 100, query: $q) {
    edges { node {
      title sku inventoryQuantity
      product { title }
    } }
  }
}`;

/**
 * What Shopify thinks is in stock for a style. Requires `read_products` (and
 * `read_inventory` for per-location detail) — without them this returns a clear
 * `permission` result rather than an error or, worse, a zero that reads as "none left".
 */
export async function shopifyInventoryForSku(sku) {
  if (!shopifyConfigured()) return null;
  const term = String(sku || '').trim();
  if (!term) return null;
  const cacheKey = `shop:inv:${key(term)}`;
  const hit = cacheGet(cacheKey);
  if (hit !== null) return hit;

  const r = await gql(INVENTORY_QUERY, { q: term });
  if (!r.ok) {
    const out = r.denied
      ? { permission: 'Shopify inventory needs the read_products / read_inventory scopes, which this token does not have. Say the quantity is unavailable — do not report zero.' }
      : { error: 'Shopify inventory lookup failed' };
    // 60s, not the 5 minutes this used to be. A permissions failure gets fixed within
    // seconds of someone noticing it, and caching the refusal makes the fix look like
    // it didn't work — which is exactly how an afternoon gets lost.
    cacheSet(cacheKey, out, 60 * 1000);
    return out;
  }
  const rows = (r.data?.productVariants?.edges || []).map((e) => e.node);
  const bySize = {};
  let total = 0;
  for (const v of rows) {
    const qty = Number(v.inventoryQuantity) || 0;
    if (qty <= 0) continue;
    total += qty;
    bySize[v.title || '?'] = (bySize[v.title || '?'] || 0) + qty;
  }
  const out = { total, sizes: bySize, variants: rows.length, source: 'Shopify inventory' };
  cacheSet(cacheKey, out, 10 * 60 * 1000);
  return out;
}
