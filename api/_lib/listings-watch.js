// Listings kept fresh by the SERVER, not by whoever has a page open (owner, 2026-11-10:
// "check the Shopify listing all the time, not only when I open the page … if a new product is
// added to Shopify we should detect it and update the record, as well as an inventory change").
// docs/context/shopify-listings.md "Kept fresh by the server".
//
// Shopify Listings:
//   • a FULL re-read of every Shopify variant every 30 min (listings-watch-worker.js) — the net
//     under everything: a webhook Shopify never sent is caught here.
//   • each Shopify webhook (api/shopify/webhook.js) → that ONE product re-read live and saved:
//     products/create · products/update · inventory_levels/update (→ its product) · products/delete.
//   • market price (Alias, the same lookup the page used to run in the browser) for every IN-STOCK
//     active size, re-checked when older than LISTINGS_MARKET_HOURS (default 6 h); new sizes first.
// The page reads the stored copy; until the first full re-read has finished it reads Shopify live.
import { shopifyAllVariants, shopifyProductListingVariants, shopifyProductForInventoryItem, shopifyConfigured } from './shopify.js';
import {
  upsertShopifyListingVariants, pruneShopifyListingVariants, replaceShopifyListingProduct, countShopifyListingVariants,
  listShopifyListingVariants, listMarketPrices, saveMarketPrices, getSetting, setSetting, dbConfigured,
} from './db.js';
import { priceStyleSize } from './ebay-reprice.js';
import { jobsFor, inStock } from '../../src/lib/shopifyListings.js';
import { cacheKey } from '../../src/lib/ebayReprice.js';

export const CHECK_KEY = 'shopify_listings_check';
const MARKET_KEY = 'shopify_listings_market';
const STALE_MS = 20 * 60_000;    // a "running" full read older than this died with the process
const marketHours = () => Math.max(1, Number(process.env.LISTINGS_MARKET_HOURS) || 6);

const readJson = async (k) => { try { return JSON.parse((await getSetting(k)) || 'null'); } catch { return null; } };
export const lastShopifyCheck = () => readJson(CHECK_KEY);
export const lastMarketPass = () => readJson(MARKET_KEY);

let fullRunning = false;
/** Every Shopify variant → the stored copy. Never prunes on a partial read. */
export async function shopifyFullCheck(by = 'auto (every 30 min)') {
  if (!shopifyConfigured() || !dbConfigured()) return { skipped: 'Shopify or the database is not set up' };
  if (fullRunning) return { skipped: 'a re-read is running' };
  const last = await lastShopifyCheck();
  if (last?.state === 'running' && Date.now() - Date.parse(last.startedAt) < STALE_MS && last.pid !== process.pid) return { skipped: 'a re-read is running' };
  fullRunning = true;
  const startedAt = new Date().toISOString();
  const put = (o) => setSetting(CHECK_KEY, JSON.stringify({ by, startedAt, pid: process.pid, ...o }), by).catch(() => {});
  try {
    await put({ state: 'running', prev: last?.state === 'done' ? { at: last.at, variants: last.variants } : last?.prev || null });
    const r = await shopifyAllVariants({ paced: true });
    if (r.error) throw new Error(r.error);
    const before = await countShopifyListingVariants();
    // A store that suddenly reads (nearly) empty is a Shopify hiccup, not 4,000 deleted listings.
    if (before > 200 && r.variants.length < before * 0.5) throw new Error(`Shopify returned ${r.variants.length} variants (we hold ${before}) — kept the copy, will try again`);
    const changed = await upsertShopifyListingVariants(r.variants);
    const removed = r.truncated ? 0 : await pruneShopifyListingVariants(r.variants.map((v) => v.variantId));
    const out = { state: 'done', at: new Date().toISOString(), variants: r.variants.length, changed, removed, truncated: !!r.truncated };
    await put(out);
    return out;
  } catch (e) {
    console.error('[listings-watch] shopify full read:', e.message);
    await put({ state: 'failed', at: new Date().toISOString(), error: e.message.slice(0, 300),
      lastGood: last?.state === 'done' ? last.at : last?.lastGood || null });
    return { error: e.message };
  } finally { fullRunning = false; }
}

// ── Webhooks: one product at a time, coalesced ──────────────────────────────────────────
// A burst (a bulk edit, an order taking 3 sizes) arrives as many webhooks for few products: they
// are collected for 2 s and each product is read once. In memory — a restart drops what is
// pending, and the next full re-read (≤ 30 min) catches it.
const pending = new Set();
let timer = null;
let draining = false;
const productGid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Product/${id}`);

export function queueShopifyListingProduct(productId) {
  if (!productId) return;
  pending.add(productGid(productId));
  if (!timer) timer = setTimeout(drain, 2000);
}
async function drain() {
  timer = null;
  if (draining) { if (!timer) timer = setTimeout(drain, 2000); return; }
  draining = true;
  try {
    while (pending.size) {
      const id = pending.values().next().value;
      pending.delete(id);
      try {
        const r = await shopifyProductListingVariants(id);
        if (r.error) { console.warn('[listings-watch] product read failed', id, r.error); continue; }
        await replaceShopifyListingProduct(id, r.gone ? [] : r.variants);
      } catch (e) { console.warn('[listings-watch] product', id, e.message); }
    }
  } finally { draining = false; }
}
/** inventory_levels/update names only the inventory item: find its product, then re-read that. */
export async function shopifyListingStockChanged(inventoryItemId) {
  const pid = await shopifyProductForInventoryItem(inventoryItemId);
  if (pid) queueShopifyListingProduct(pid);
  return pid;
}
export async function shopifyListingProductDeleted(productId) {
  if (!productId) return;
  pending.delete(productGid(productId));
  await replaceShopifyListingProduct(productGid(productId), []);
}
/** For tests: wait until the webhook queue is empty. */
export async function settleListingQueue() {
  for (let i = 0; i < 100 && (pending.size || draining || timer); i++) await new Promise((r) => setTimeout(r, 100));
}

// ── Market prices for every in-stock size ───────────────────────────────────────────────
let marketRunning = false;
/** Price what is missing or older than LISTINGS_MARKET_HOURS, oldest first, at most `max` lookups. */
// `variants` / `price` are for tests (e2e/listings-watch.spec.js): a given list instead of the stored
// copy, and a fake lookup — so a test never writes made-up prices for real shoes.
export async function marketPass({ max = 600, by = 'auto (every 30 min)', price = priceStyleSize, variants: given = null } = {}) {
  if (!process.env.ALIAS_API_KEY && price === priceStyleSize) return { skipped: 'no Alias API key' };
  if (marketRunning) return { skipped: 'a market pass is running' };
  marketRunning = true;
  try {
    const variants = given || await listShopifyListingVariants();
    const want = jobsFor(variants.filter((v) => v.status === 'ACTIVE' && inStock(v)));
    const have = new Map((await listMarketPrices()).map((r) => [cacheKey(r.sku, r.size), r]));
    const cutoff = Date.now() - marketHours() * 3_600_000;
    const due = want
      .map((j) => ({ ...j, at: have.get(cacheKey(j.sku, j.size))?.checked_at }))
      .filter((j) => !j.at || new Date(j.at).getTime() < cutoff)
      .sort((a, b) => (a.at ? new Date(a.at).getTime() : 0) - (b.at ? new Date(b.at).getTime() : 0))
      .slice(0, max);
    let done = 0; let errors = 0; let next = 0;
    const batch = [];
    const flush = async () => { if (batch.length) { await saveMarketPrices(batch.splice(0)); } };
    await Promise.all(Array.from({ length: Math.min(4, due.length) }, async () => {
      while (next < due.length) {
        const j = due[next++];
        const r = await price(j.sku, j.size).catch((e) => ({ ...j, status: 'error', error: e.message }));
        if (r.status === 'error') errors++; else { batch.push(r); done++; }
        if (batch.length >= 25) await flush();
      }
    }));
    await flush();
    const out = { at: new Date().toISOString(), by, sizes: want.length, priced: done, errors, due: due.length };
    if (!given) await setSetting(MARKET_KEY, JSON.stringify(out), by).catch(() => {});
    return out;
  } finally { marketRunning = false; }
}
