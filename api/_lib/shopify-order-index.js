// The Shopify order index (docs/context/cancellations.md "The Shopify order index").
//
// Every sales channel lands in Shopify as an order, and each connector keeps the MARKETPLACE'S
// OWN order number — the one printed on the label or packing slip the floor photographs —
// somewhere different. Measured on the live store, 2026-11-21:
//   StockX        order name "06-B1P9GP5N4H"  (+ attribute "StockX Order Number")
//   GOAT (Alias)  attribute g_order_number "637973365"  (g_platform goat | flight_club |
//                 sneakers_dot_com — all sold through Alias); the order name is our own "#33938"
//   Stadium Goods attribute "Order Number" / the note "CK5191645963" (+ "Tracking Number")
//   Temu          source identifier "PO-211-15609528842871006" (+ line attribute ORDER_SN)
//   Kicks Crew    order name "KS2699631"  (+ attribute "KICKSCREW Order Number")
//   eBay          order name "07-15461-19264"
//   SHEIN         source identifier "GSU1A607200MC1M"
//   TikTok        a tag "TikTokOrderID:5776947…"
// Shopify's own search finds only some of those (never an attribute or a note — measured), so
// this keeps a copy we can search: one row per order, with every number it could be asked by.
//
// Read-only on Shopify. First run = the last 30 days (about 110 pages for this store, a few
// minutes); afterwards only what changed since the cursor. State in app_settings
// .shopify_order_index_sync — `firstDone` + `lastAt` are what "the index is complete enough to
// say a number is NOT one of our orders" rests on (shopifyIndexFresh).
import { getSetting, setSetting, upsertShopifyOrderIndex, pruneShopifyOrderIndex } from './db.js';
import { shopifyConfigured, shopifyOrdersIndexPage, styleFromTitle } from './shopify.js';
import { canonKey } from '../../src/lib/cancellations.js';

const SYNC_KEY = 'shopify_order_index_sync';
const STALE_MS = 10 * 60 * 1000;
const FIRST_DAYS = 30;
const OVERLAP_MS = 2 * 60 * 1000;   // Shopify's search index lags a moment behind the order
const MAX_PAGES = 80;               // one run reads at most 4,000 orders; the cursor carries on
const KEEP_DAYS = 75;
/** How recently the index must have synced for "not in Shopify" to mean anything. */
export const FRESH_MS = 30 * 60 * 1000;

export const numberKey = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const attr = (list, key) => (list || []).find((a) => String(a?.key || '').toLowerCase() === key.toLowerCase())?.value || null;

/** Which of OUR platform keys (src/lib/cancellations.js PLATFORMS) a Shopify order belongs to. */
export function platformOfShopifyOrder(node) {
  const who = `${node?.app?.name || ''} | ${node?.channelInformation?.channelDefinition?.channelName || ''} | ${node?.sourceName || ''}`;
  if (/stockx/i.test(who)) return 'stockx';
  if (/\bgoat\b/i.test(who) || attr(node?.customAttributes, 'g_order_number')) return 'alias';
  if (/sgapp|stadium\s*goods/i.test(who)) return 'sg';
  if (/\btemu\b/i.test(who)) return 'temu';
  if (/kicks\s*crew/i.test(who)) return 'kc';
  if (/\bebay\b/i.test(who)) return 'ebay';
  if (/tik\s*tok/i.test(who)) return 'tiktok';
  if (/\bshein\b/i.test(who)) return 'shein';
  return null;   // our own web store, POIZON, a draft order … — not something the bot is sent
}

/**
 * A Shopify order → its index row, or null when it is not a marketplace order or carries no
 * number. Pure (tested with the real shapes in e2e/cancellations.spec.js).
 */
export function orderIndexRow(node) {
  const platform = platformOfShopifyOrder(node);
  if (!platform) return null;
  const a = node.customAttributes || [];
  const lineAttrs = (node.lineItems?.edges || []).flatMap(({ node: l }) => l.customAttributes || []);
  const name = String(node.name || '').trim();
  const printed = [];   // the numbers as written, most "the order number" first
  const add = (v) => { const s = String(v ?? '').trim(); if (s && numberKey(s).length >= 6) printed.push(s); };
  if (platform === 'stockx') { add(attr(a, 'StockX Order Number')); add(name); }
  if (platform === 'alias') add(attr(a, 'g_order_number'));
  if (platform === 'sg') { add(attr(a, 'Order Number')); add(node.note); }
  if (platform === 'temu') { add(node.sourceIdentifier); add(attr(a, 'PARENT_ORDER_SN')); for (const x of lineAttrs.filter((y) => y.key === 'ORDER_SN')) add(x.value); }
  if (platform === 'kc') { add(attr(a, 'KICKSCREW Order Number')); add(name); }
  if (platform === 'ebay') { add(name); add(node.sourceIdentifier); }
  if (platform === 'shein') { add(node.sourceIdentifier); add(attr(a, 'Source order id')); }
  if (platform === 'tiktok') for (const t of node.tags || []) { const m = /^TikTokOrderID:\s*(\S+)/i.exec(String(t)); if (m) add(m[1]); }
  // Our own "#33938" is never a marketplace number.
  const seen = new Set(); const numbers = []; const texts = [];
  for (const p of printed) {
    if (/^#?\d{4,6}$/.test(p)) continue;
    const k = numberKey(p);
    if (seen.has(k)) continue;
    seen.add(k); numbers.push(k); texts.push(p.replace(/^#/, ''));
  }
  const trackings = [...new Set([
    ...(node.fulfillments || []).flatMap((f) => (f.trackingInfo || []).map((t) => t.number)),
    attr(a, 'Tracking Number'),
  ].map(numberKey).filter((t) => t.length >= 8))];
  if (!numbers.length && !trackings.length) return null;
  const lines = (node.lineItems?.edges || []).map(({ node: l }) => {
    const style = styleFromTitle(l.title);
    const title = String(l.title || '').trim();
    // "Jordan 4 Retro Rare Air Tour Yellow (IO2463-102)" → the name without its style code.
    const sk = numberKey(style);
    const nameOnly = !style ? title : title
      .replace(/\s*\(([^()]*)\)\s*$/, (m, inner) => (numberKey(inner).includes(sk) ? '' : m))
      .replace(/\s*[-–]\s*([A-Z0-9-]+)\s*$/i, (m, code) => (numberKey(code) === sk ? '' : m))
      .trim();
    return { style: style || null, size: l.variantTitle || null, name: nameOnly || title || null, title: title || null };
  });
  return {
    shopify_order_id: String(node.id || '').split('/').pop(),
    name, channel: node.app?.name || node.channelInformation?.channelDefinition?.channelName || null, platform,
    numbers, number_texts: texts, numbers_canon: numbers.map((k) => canonKey(k)), trackings, lines,
    ordered_at: node.createdAt || null, cancelled_at: node.cancelledAt || null, shopify_updated_at: node.updatedAt || null,
  };
}

export async function readIndexSync(key = SYNC_KEY) {
  try { return JSON.parse((await getSetting(key)) || 'null'); } catch { return null; }
}
export const indexSyncRunning = (s) => s?.state === 'running' && Date.now() - Date.parse(s.startedAt) < STALE_MS;
/**
 * Has the index read everything, recently? Only then does "this number is in none of our
 * Shopify orders" say anything about the number (a dev machine never syncs: never fresh).
 */
export async function shopifyIndexFresh(now = Date.now()) {
  const s = await readIndexSync().catch(() => null);
  return !!(s?.firstDone && s.lastAt && now - Date.parse(s.lastAt) < FRESH_MS);
}

let inFlight = null;
// `io` lets a test stand in for Shopify and the table (and keep its state under its own key).
export function runShopifyOrderIndexSync({ by = 'auto', io = null } = {}) {
  if (inFlight) return inFlight;
  inFlight = sync({ by, io: io || { page: shopifyOrdersIndexPage, save: upsertShopifyOrderIndex, prune: pruneShopifyOrderIndex, configured: shopifyConfigured } })
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function sync({ by, io }) {
  const key = io.key || SYNC_KEY;
  const prev = (await readIndexSync(key)) || {};
  const startedAt = new Date().toISOString();
  const keep = { cursor: prev.cursor || null, lastAt: prev.lastAt || null, firstDone: !!prev.firstDone };
  const put = (o) => setSetting(key, JSON.stringify({ ...keep, by, startedAt, ...o }), by).catch(() => {});
  if (!io.configured()) { await put({ state: 'error', error: 'Shopify isn’t set up on this server.' }); return { error: 'not configured' }; }
  await put({ state: 'running', read: 0, kept: 0 });
  const since = keep.cursor ? new Date(Date.parse(keep.cursor) - OVERLAP_MS).toISOString() : new Date(Date.now() - FIRST_DAYS * 86_400_000).toISOString();
  let after = null; let read = 0; let kept = 0; let cursor = keep.cursor; let more = false;
  try {
    for (let p = 0; p < MAX_PAGES; p += 1) {
      const r = await io.page(since, after);
      if (r.error) throw Object.assign(new Error(r.code === 'denied' ? 'Shopify refused: the app needs the read_orders scope.' : r.error), { code: r.code });
      read += r.orders.length;
      const rows = r.orders.map(orderIndexRow).filter((x) => x && x.shopify_order_id);
      if (rows.length) { await io.save(rows); kept += rows.length; }
      // Pages come oldest change first, so everything up to this page's last order is stored.
      const last = r.orders[r.orders.length - 1]?.updatedAt;
      if (last && (!cursor || last > cursor)) cursor = last;
      keep.cursor = cursor;
      after = r.next;
      more = !!after;
      if (!after) break;
      if (p % 5 === 4) await put({ state: 'running', read, kept });
    }
    // lastAt moves only when this run reached the end: a run cut at MAX_PAGES is not "current".
    if (!more) { keep.lastAt = new Date().toISOString(); keep.firstDone = true; }
    if (io.prune) await io.prune(KEEP_DAYS).catch(() => {});
    await put({ state: 'done', read, kept, more });
    return { ok: true, read, kept, more };
  } catch (e) {
    await put({ state: 'error', error: e.message, read, kept });
    return { error: e.message };
  }
}

// ── The worker ──
// Every 5 minutes (SHOPIFY_ORDER_INDEX_MIN). Production only by default — a dev machine would
// read the live store for nothing; SHOPIFY_ORDER_INDEX=on|off overrides.
export function shopifyOrderIndexWorkerEnabled(env = process.env) {
  const flag = String(env.SHOPIFY_ORDER_INDEX || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}
let started = false;
export function startShopifyOrderIndexWorker() {
  if (started || !shopifyOrderIndexWorkerEnabled()) return;
  started = true;
  const every = Math.max(2, Number(process.env.SHOPIFY_ORDER_INDEX_MIN) || 5) * 60_000;
  console.log(`[shopify-order-index] worker on: changed Shopify orders every ${every / 60_000} min`);
  const run = async () => {
    try {
      if (!shopifyConfigured() || indexSyncRunning(await readIndexSync())) return;
      const out = await runShopifyOrderIndexSync({ by: 'auto' });
      if (out.error) console.error('[shopify-order-index]', out.error);
      else if (out.more) setTimeout(run, 20_000).unref?.();   // the first run: keep going until it has caught up
    } catch (e) { console.error('[shopify-order-index] tick', e.message); }
  };
  setTimeout(() => { run(); setInterval(run, every).unref?.(); }, 90_000).unref?.();
}
