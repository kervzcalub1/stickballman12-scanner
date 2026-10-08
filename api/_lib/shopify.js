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
import { estDate } from '../../src/lib/format.js';

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
  // `r.ok` check would read a refusal as success. It is not ALWAYS an array, though:
  // an auth-level failure comes back as `{"errors": "Invalid API key or access token"}`,
  // a bare string, and calling .find on that threw — taking down every caller of this
  // helper, including tools that had perfectly good non-Shopify data to return.
  const errs = Array.isArray(data?.errors)
    ? data.errors
    : (data?.errors ? [{ message: String(data.errors) }] : []);
  const text = errs.map((e) => e?.message || '').join(' | ');
  // TWO different refusals, and they had one name between them (2026-08-26). A dead
  // token answers 401 "Invalid API key or access token"; a live token missing a grant
  // answers 200 with "Access denied for orders field". Both used to surface as "not
  // permitted", which sends whoever reads it to the scopes screen — where a revoked
  // token looks perfectly fine, because the scopes ARE right. The fixes are different
  // people doing different things, so the diagnosis has to be too.
  const unauthorized = r.status === 401 || /invalid api key|unrecognized login|wrong password/i.test(text);
  const denied = !unauthorized && /access denied|scope|not approved/i.test(text);
  return {
    ok: r.ok && !errs.length,
    status: r.status,
    data: data?.data,
    errors: errs.length ? errs : undefined,
    unauthorized,
    denied,
  };
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
  // Money and calendar months, bucketed inside the fetch that already runs. "Sales" means
  // dollars as often as it means pairs, and "how did each month go" is the question people
  // actually ask — neither costs an extra call, only arithmetic on rows already in hand.
  const byMonth = new Map();
  let revenue = 0;
  let orders = 0; let units = 0; let unmatched = 0;
  let after = null; let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = await gql(ORDERS_QUERY, { q: `created_at:>=${estDaysAgo(d)}`, after });
    if (!r.ok) {
      if (r.unauthorized) console.error('[shopify] SHOPIFY_ACCESS_TOKEN rejected (401) — the token is wrong, revoked, or from another store.');
      return {
        error: r.unauthorized
          ? 'Shopify rejected our access token — it is revoked or wrong, so no sales can be read until it is replaced.'
          : r.denied ? 'not permitted' : 'Shopify sales lookup failed',
        days: d,
      };
    }
    const conn = r.data?.orders;
    for (const { node } of conn?.edges || []) {
      orders += 1;
      const channel = node.channelInformation?.channelDefinition?.channelName || node.app?.name || 'unknown';
      byChannel[channel] = (byChannel[channel] || 0) + 1;
      // The month an order belongs to is its EST month, never the host's or UTC's — an
      // order placed 8pm EST on the 31st is that month's, and UTC would file it in the next.
      const day = estDate(node.createdAt);
      const mk = day.slice(0, 7);
      const month = byMonth.get(mk) || { month: mk, orders: 0, units: 0, revenue: 0, channels: {} };
      month.orders += 1;
      byMonth.set(mk, month);
      for (const li of node.lineItems?.edges || []) {
        const item = li.node;
        const qty = Number(item.quantity) || 1;
        units += qty;
        // Read the money BEFORE the unmatched-style bail-out. A line whose title carries no
        // style code is still a sale that took money; dropping it here would understate
        // every revenue figure by whatever the unmatched units were worth.
        const price = Number(item.originalUnitPriceSet?.shopMoney?.amount);
        const money = Number.isFinite(price) && price > 0 ? price * qty : 0;
        revenue += money;
        month.units += qty;
        month.revenue += money;
        const mc = month.channels[channel] || { units: 0, revenue: 0 };
        mc.units += qty;
        mc.revenue += money;
        month.channels[channel] = mc;
        const style = styleFromTitle(item.title);
        if (!style) { unmatched += qty; continue; }
        const k = key(style);
        const e = byStyle.get(k) || { style_id: style, name: item.title, sold: 0, revenue: 0, channels: {}, sizes: {}, prices: [], last_sold: null };
        e.sold += qty;
        e.channels[channel] = (e.channels[channel] || 0) + qty;
        if (item.variantTitle) e.sizes[item.variantTitle] = (e.sizes[item.variantTitle] || 0) + qty;
        if (Number.isFinite(price) && price > 0) e.prices.push(price);
        e.revenue += money;
        // `day` is the EST civil date computed above. It used to be a UTC slice of
        // createdAt, which dated an evening sale to tomorrow.
        if (!e.last_sold || day > e.last_sold) e.last_sold = day;
        byStyle.set(k, e);
      }
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  const money2 = (n) => Math.round(n * 100) / 100;

  // Newest month first. The oldest and newest entries are marked `partial`: the window is
  // a rolling number of days, so it opens part-way through one month and ends part-way
  // through the current one. An unmarked part-month reads as a collapse in trade that
  // never happened, which is the one way a monthly table actively misleads.
  const monthRows = [...byMonth.values()]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .map((m) => ({
      ...m,
      revenue: money2(m.revenue),
      channels: Object.fromEntries(Object.entries(m.channels)
        .map(([k, v]) => [k, { units: v.units, revenue: money2(v.revenue) }])
        .sort((a, b) => b[1].units - a[1].units)),
    }));
  if (monthRows.length) {
    monthRows[0].partial = true;
    monthRows[monthRows.length - 1].partial = true;
  }

  const out = {
    days: d,
    orders,
    units,
    revenue: money2(revenue),
    // Titles with no style code in them. Reported, never silently folded into a style.
    unmatched_units: unmatched,
    channels: byChannel,
    // Whole calendar months, newest first. The FIRST and LAST are part-months — the window
    // is a rolling N days, not a run of complete months — and each says so, because a
    // part-month read as a full one looks like a collapse in sales that never happened.
    months: monthRows,
    months_note: 'Calendar months inside the window. The oldest and newest are PART months — the window is a rolling number of days, so neither is a full month of trading.',
    truncated,
    styles: [...byStyle.values()].map((e) => ({
      ...e,
      avg_price: e.prices.length ? Math.round((e.prices.reduce((a, b) => a + b, 0) / e.prices.length) * 100) / 100 : null,
      prices: undefined,
      revenue: money2(e.revenue),
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
    const out = r.unauthorized
      ? { permission: 'Shopify rejected our access token — it is revoked or wrong. Say the quantity is unavailable and that the Shopify connection needs reconnecting; do not report zero.' }
      : r.denied
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

/* ------------------------------------------------------------------ */
/* Shopify Reprice (PH) — docs/context/shopify-reprice.md              */
/* ------------------------------------------------------------------ */

// Why a refusal happened, in words that send the reader to the right fix.
function failure(r, what) {
  if (r.unauthorized) return { error: 'Shopify rejected our access token — it is revoked or wrong. Reset SHOPIFY_ACCESS_TOKEN.', code: 'unauthorized' };
  if (r.denied) {
    return what === 'write'
      ? { error: 'Shopify refused the price change: the app needs the write_products scope. Add it to the “Stickballman12 AI” app in the Dev Dashboard, release, and approve it on the store.', code: 'denied' }
      : { error: 'Shopify refused: the app needs the read_products scope.', code: 'denied' };
  }
  return { error: r.errors?.map((e) => e.message).join(' | ') || `Shopify answered ${r.status}`, code: 'error' };
}

const VARIANTS_QUERY = `query Variants($after: String) {
  productVariants(first: 250, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id sku title price inventoryQuantity
      selectedOptions { name value }
      product { id title status }
    } }
  }
}`;

// Every variant in the store (≈ 3,900 → ~16 pages), with the style code read off the
// PRODUCT title the same way the sales feed does — the variant `sku` is an internal
// number here ("10019029"), so it is used only when it looks like a style code itself.
export async function shopifyAllVariants() {
  if (!shopifyConfigured()) return { error: 'Shopify is not configured on the server.', code: 'config' };
  const out = [];
  let after = null;
  for (let page = 0; page < 80; page++) {
    const r = await gql(VARIANTS_QUERY, { after });
    if (!r.ok) return failure(r, 'read');
    const conn = r.data?.productVariants;
    for (const { node: v } of conn?.edges || []) {
      const size = (v.selectedOptions || []).find((o) => /size/i.test(o.name))?.value ?? v.title;
      const skuStyle = /[A-Z]/i.test(v.sku || '') && /\d/.test(v.sku || '') && String(v.sku).length >= 5 ? String(v.sku).toUpperCase() : null;
      out.push({
        variantId: v.id, productId: v.product?.id || null, productTitle: v.product?.title || '',
        status: v.product?.status || null, sku: v.sku || '', size: String(size ?? '').trim(),
        price: v.price, qty: v.inventoryQuantity == null ? null : Number(v.inventoryQuantity),
        style: styleFromTitle(v.product?.title) || skuStyle,
      });
    }
    if (!conn?.pageInfo?.hasNextPage) return { variants: out };
    after = conn.pageInfo.endCursor;
  }
  return { variants: out, truncated: true };
}

// The price Shopify holds RIGHT NOW for each variant id — read just before writing, so a
// price someone changed after the pull is never overwritten blind.
export async function shopifyVariantPrices(ids) {
  const r = await gql(`query Prices($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price product { id } } } }`, { ids });
  if (!r.ok) return failure(r, 'read');
  return { prices: new Map((r.data?.nodes || []).filter(Boolean).map((n) => [n.id, { price: n.price, productId: n.product?.id }])) };
}

// Set prices on some variants of ONE product. Returns { ok } or { error, code } — and
// Shopify's per-variant userErrors when it accepted the call but refused a row.
export async function shopifyUpdateVariantPrices(productId, variants) {
  const r = await gql(`mutation Reprice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }`, { productId, variants: variants.map((v) => ({ id: v.id, price: v.price })) });
  if (!r.ok) return failure(r, 'write');
  const res = r.data?.productVariantsBulkUpdate;
  const errs = res?.userErrors || [];
  if (errs.length) return { error: errs.map((e) => e.message).join(' | '), code: 'rejected' };
  return { ok: true, updated: new Map((res?.productVariants || []).map((v) => [v.id, v.price])) };
}
