// eBay Sync engine (docs/ebay-sync-plan.md, docs/context/ebay-sync.md): stock, price, content, new
// listings and ending, replacing what DPL does for those. DPL keeps handling eBay ORDERS.
//
// The one rule: a write to eBay happens ONLY when that domain's switch is `live`, the kill switch is
// off AND this server may write (production, or EBAY_SYNC_WRITES=on). The switches are re-read right
// before every write and between batches, so the kill switch stops a running pass. In shadow the
// intended action goes to ebay_sync_log (mode 'shadow') and nothing is called. Every write function
// lives under `io.write`, so a test can hand in writers that fail the moment they are touched.
//
// Passes (api/_lib/ebay-sync-worker.js): queue 30 s, reconcile / content / create 30 min. A pass that
// fails records why and retries next time; a pass never overlaps itself; one listing is never revised
// by two requests at once.
import crypto from 'node:crypto';
import {
  getSetting, ebaySyncStateGet, ebaySyncStateSet, ebaySyncPatchSettings, ebaySyncDefaultProfile, ebaySyncLogAdd, ebaySyncLogPrune, ebaySyncLoggedRecently,
  ebaySyncLiveToday, ebaySyncLiveDone, ebaySyncLiveCount, ebaySyncListingCount, ebaySyncMoveItemId, ebaySyncEndedByApp, ebaySyncDropListing,
  ebaySyncClaimQueue, ebaySyncQueueDone, ebaySyncQueueCount, ebaySyncLinkPrev, ebaySyncReplaceLinks, ebaySyncLinksBySku, ebaySyncSetLinkQty,
  ebaySyncLinksByItem, ebaySyncItemsOfProducts, ebaySyncEbaySkus, ebaySyncRepricedKeys, ebaySyncProductPrev, ebaySyncUpsertProducts, ebaySyncPatchProduct,
  ebaySyncProductsToVerify, ebaySyncProductsToAdd, ebaySyncProductsToCheck, ebaySyncProductTabs, ebaySyncListingTabs, ebaySyncFacts, ebaySyncLinkCount,
  ebayLockedItemIds, logEbayEnd, dbConfigured,
} from './db.js';
import {
  ebayConfigured, ebayStatus, fetchActiveListings, fetchEbayItemContent, verifyAddFixedPriceItem, addFixedPriceItem, reviseFixedPriceItem,
  relistFixedPriceItem, reviseEbayQuantities, reviseEbayPrices, endEbayItem, tradingUsage, flushBudget, TRADING_BUDGET,
} from './ebay.js';
import {
  shopifyConfigured, shopifyAllVariants, shopifyEbayProductsLight, shopifyCollectionProductIds, shopifyEbayProductsFull, shopifyStockForSku, shopifyListingState,
} from './shopify.js';
import { alertUsers, at } from './alerts.js';
import { styleFromTitle } from '../../src/lib/ebayReprice.js';
import {
  SWITCHES, normalizeSettings, canWrite, writesAllowed, buildLinks, decideLink, driftSince, driftPersists, blastCheck, readGuard, buildListing, precheck,
  translateEbayErrors, contentDiff, productKey, handoverChecklist, endsByZero,
} from '../../src/lib/ebaySync.js';

export const SETTINGS_KEY = 'ebay_sync';
const stateKey = (pass) => `ebay_sync_state_${pass}`;
export const PASSES = ['queue', 'reconcile', 'content', 'create'];
export const MAX_CREATE_PER_DAY = 25;
export const MAX_VERIFY_PER_PASS = 10;
export const MAX_CONTENT_PER_PASS = 40;
export const CONTENT_SWEEP_PER_DAY = 100;
export const CONTENT_STOP = 2000;       // the content pass stops reading at this many Trading calls used today
export const MAX_QUEUE_CLAIM = 100;
export const MAX_LIVE_STOCK_READS = 200;
export const CHUNK = 20;                // writes go out 20 at a time, the switches re-read before each
export const SETTLE_MIN = 10;

export const IO = {
  getSetting, patchSettings: ebaySyncPatchSettings,
  getState: ebaySyncStateGet, setState: ebaySyncStateSet,
  now: () => new Date(),
  // ---- reads ----
  dbReady: dbConfigured,
  ebayReady: async () => ebayConfigured() && !!(await ebayStatus()).connected,
  shopifyReady: shopifyConfigured,
  budget: tradingUsage, flushBudget,
  fetchActiveListings: (styleOf) => fetchActiveListings(styleOf, undefined, { guard: 'read' }),
  fetchEbayItemContent, verifyAddFixedPriceItem,
  allVariants: () => shopifyAllVariants({ paced: true }), productsLight: shopifyEbayProductsLight, collectionIds: shopifyCollectionProductIds,
  productsFull: shopifyEbayProductsFull, stockForSku: shopifyStockForSku,
  productsState: (ids) => shopifyListingState([], ids),
  lockedItemIds: ebayLockedItemIds, repricedKeys: ebaySyncRepricedKeys,
  profile: ebaySyncDefaultProfile,
  db: {
    logAdd: ebaySyncLogAdd, loggedRecently: ebaySyncLoggedRecently, liveToday: ebaySyncLiveToday, liveCount: ebaySyncLiveCount, listingCount: ebaySyncListingCount,
    claimQueue: ebaySyncClaimQueue, queueDone: ebaySyncQueueDone,
    linkPrev: ebaySyncLinkPrev, replaceLinks: ebaySyncReplaceLinks, linksBySku: ebaySyncLinksBySku, setLinkQty: ebaySyncSetLinkQty, linksByItem: ebaySyncLinksByItem,
    itemsOfProducts: ebaySyncItemsOfProducts, ebaySkus: ebaySyncEbaySkus, productPrev: ebaySyncProductPrev, upsertProducts: ebaySyncUpsertProducts,
    patchProduct: ebaySyncPatchProduct, linkCount: ebaySyncLinkCount, productTabs: ebaySyncProductTabs, endedByApp: ebaySyncEndedByApp,
    toVerify: ebaySyncProductsToVerify, toAdd: ebaySyncProductsToAdd, toCheck: ebaySyncProductsToCheck, prune: ebaySyncLogPrune, moveItemId: ebaySyncMoveItemId,
    dropListing: ebaySyncDropListing,
  },
  // ---- every WRITE this feature can make to eBay (only ever reached through the live checks) ----
  write: { reviseEbayQuantities, reviseEbayPrices, addFixedPriceItem, reviseFixedPriceItem, relistFixedPriceItem, endEbayItem, logEbayEnd },
  alert: (ref, title, body) => alertUsers('ebay_sync', { ref, once: true, code: title, body, path: at('ebaysync') }),
};

/* ------------------------------ settings + pass state ------------------------------ */

const jparse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
export async function readSettings(io = IO) { return normalizeSettings(jparse(await io.getSetting(SETTINGS_KEY))); }
// Changes are merged in the database in ONE statement (a kill switch can't lose to a switch change made at
// the same moment), and each change is logged with who.
export async function saveSettings(patch, by, io = IO) {
  const cur = await readSettings(io);
  const out = {};
  const changes = [];
  for (const [k, v] of Object.entries(patch?.switches || {})) {
    if (!SWITCHES.includes(k) || !['off', 'shadow', 'live'].includes(v) || cur.switches[k] === v) continue;
    out.switches = { ...(out.switches || {}), [k]: v }; changes.push([`switch ${k}`, cur.switches[k], v]);
  }
  if (typeof patch?.kill === 'boolean' && patch.kill !== cur.kill) { out.kill = patch.kill; changes.push(['kill', cur.kill, patch.kill]); }
  if (patch?.blastPct != null) {
    const n = normalizeSettings({ blastPct: patch.blastPct }).blastPct;
    if (n !== cur.blastPct) { out.blastPct = n; changes.push(['blastPct', cur.blastPct, n]); }
  }
  if (changes.length) await io.patchSettings(out, by || null);
  for (const [what, before, after] of changes) await io.db.logAdd({ domain: 'settings', action: what, mode: 'live', before: { value: before }, after: { value: after }, by });
  return readSettings(io);
}
export async function readState(pass, io = IO) { return jparse(await io.getState(stateKey(pass))) || {}; }
async function patchState(io, pass, patch) {
  const cur = jparse(await io.getState(stateKey(pass))) || {};
  await io.setState(stateKey(pass), JSON.stringify({ ...cur, ...patch }));
}

/* ------------------------------------ helpers ------------------------------------ */

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex').toUpperCase();   // 32 chars of 0-9 A-F, what eBay's UUID / InvocationID take
// Re-read the switches (the kill switch included) and say whether this domain may write NOW.
async function liveNow(ctx, domain) {
  ctx.settings = await readSettings(ctx.io);
  return canWrite(ctx.settings, domain);
}
// The single door to a write. Shadow (or kill, off, or a server that may not write) never calls `fn`.
async function shadowOrDo(ctx, domain, spec, fn) {
  const { io } = ctx;
  const row = { domain, action: spec.action, itemId: spec.itemId ?? null, sku: spec.sku ?? null, before: spec.before ?? null, by: ctx.by };
  if (!(await liveNow(ctx, domain))) {
    // The same intended action is not logged again every pass.
    if (spec.once && await io.db.loggedRecently(domain, spec.action, spec.itemId ?? null, 24)) return { shadow: true, skipped: true };
    await io.db.logAdd({ ...row, mode: 'shadow', after: spec.after ?? null });
    return { shadow: true };
  }
  let res;
  try { res = await fn(); } catch (e) { res = { ok: false, error: e.message }; }
  await io.db.logAdd({ ...row, mode: 'live', after: spec.after ?? null, ok: res?.ok !== false, error: res?.error || null });
  return res || { ok: true };
}
async function ensureBudget(io, kind = 'read', stopAt = null) {
  const b = await io.budget();
  const stop = stopAt ?? (kind === 'write' ? TRADING_BUDGET.writeStop : TRADING_BUDGET.readStop);
  if (b.used >= stop) throw new Error(`eBay Trading budget for today is nearly spent (${b.used} of ${b.limit}); passes resume after 08:00 UTC.`);
}
async function requireConnections(io) {
  if (!(await io.shopifyReady())) throw new Error('Shopify is not configured on this server.');
  if (!(await io.ebayReady())) throw Object.assign(new Error('eBay is not connected: an admin presses Connect eBay first.'), { notConnected: true });
}
const profileOf = async (io) => (await io.profile())?.config || {};
const sizeOfLink = (l) => (l.variation_key ? l.sku : null);
// Blast limit over a SLIDING hour: what this domain already did live in the last hour plus this batch.
async function blastFor(ctx, domain, action, batch, total) {
  const recent = await ctx.io.db.liveCount(domain, action, 60);
  return blastCheck({ changes: recent + batch, total, blastPct: ctx.settings.blastPct });
}
async function blockWith(ctx, domain, blast, title, body) {
  await ctx.io.alert(`blast:${domain}:${dayKey(ctx.io.now())}`, title, body);
  await ctx.io.db.logAdd({ domain, action: 'blast_stop', mode: 'live', after: blast, ok: false, error: 'blast limit', by: ctx.by });
}
// One request per listing / product at a time, across passes and manual actions.
const busy = new Set();
const withLock = async (key, fn) => { if (busy.has(key)) return { ok: false, error: 'Another change to this listing is in progress.', skipped: true }; busy.add(key); try { return await fn(); } finally { busy.delete(key); } };
// Shopify's live available quantity for a SKU, or null when it can't be trusted (error, no stock levels, untracked).
async function liveQty(io, sku) {
  const st = await io.stockForSku(sku);
  if (!st || st.error || !st.levels?.length || st.tracked === false) return null;
  return Math.max(0, st.levels.reduce((n, l) => n + Number(l.available || 0), 0));
}

/* ------------------------------ stock + price + end ------------------------------ */

// changes: [{ link, qty }]. Sliding-window blast check, a shadow row or the live writes in chunks.
async function pushStock(ctx, changes, total, listingTotal) {
  const { io } = ctx;
  if (!changes.length || ctx.settings.switches.stock === 'off') return { sent: 0 };
  const byItem = new Map();
  for (const itemId of new Set(changes.map((c) => c.link.item_id))) byItem.set(itemId, await io.db.linksByItem(itemId));
  const ends = endsByZero(changes, (id) => byItem.get(id));
  const live = await liveNow(ctx, 'stock');
  if (!live) {
    const blast = blastCheck({ changes: changes.length, total, blastPct: ctx.settings.blastPct });
    await shadowOrDo(ctx, 'stock', { action: 'set_qty', after: { count: changes.length, blast, sample: changes.slice(0, 10).map((c) => ({ item: c.link.item_id, sku: c.link.sku, from: c.link.ebay_qty, to: c.qty })) } });
    for (const itemId of ends) await shadowOrDo(ctx, 'end', { action: 'zero_ends_listing', itemId, once: true, after: { why: 'every size would be at 0, which ends the listing on eBay' } });
    return { sent: 0, would: changes.length };
  }
  const blast = await blastFor(ctx, 'stock', 'set_qty', changes.length, total);
  const endBlast = ends.length ? await blastFor(ctx, 'end', 'end_listing', ends.length, listingTotal || total) : null;
  if (blast.stop || endBlast?.stop) {
    const b = blast.stop ? blast : endBlast;
    await blockWith(ctx, blast.stop ? 'stock' : 'end', b, 'eBay Sync stopped: stock', `Stock would change on ${changes.length} sizes${ends.length ? ` and end ${ends.length} listings` : ''} (${b.pct}% of ${b.total} in the last hour; the limit is ${b.blastPct}%). Nothing was sent.`);
    return { sent: 0, blocked: b };
  }
  await ensureBudget(io, 'write');
  const by = new Map(changes.map((c) => [c.link.link_key, c]));
  const ok = new Set();
  let sent = 0;
  for (let i = 0; i < changes.length; i += CHUNK) {
    if (!(await liveNow(ctx, 'stock'))) break;   // the kill switch was pressed while this pass was running
    const results = await io.write.reviseEbayQuantities(changes.slice(i, i + CHUNK).map((c) => ({ key: c.link.link_key, itemId: c.link.item_id, sku: sizeOfLink(c.link), qty: c.qty })));
    for (const r of results) {
      const c = by.get(r.key);
      if (r.ok) { sent++; ok.add(r.key); await io.db.setLinkQty(c.link.link_key, c.qty).catch(() => {}); }
      await io.db.logAdd({ domain: 'stock', action: 'set_qty', mode: 'live', itemId: c.link.item_id, sku: c.link.sku, before: { qty: c.link.ebay_qty }, after: { qty: c.qty }, ok: !!r.ok, error: r.error || null, by: ctx.by });
      if (r.auth) await io.alert(`auth:${dayKey(io.now())}`, 'eBay Sync lost its eBay connection', 'eBay refused a stock change as not authorised. An admin presses Connect eBay again.');
    }
  }
  // A push that took the last size of a listing to 0 ended it (out-of-stock control is off): same effect as an end.
  for (const itemId of ends) {
    if (byItem.get(itemId).some((l) => by.has(l.link_key) && !ok.has(l.link_key))) continue;
    await io.db.logAdd({ domain: 'end', action: 'end_listing', mode: 'live', itemId, before: { title: byItem.get(itemId)[0]?.title }, after: { via: 'stock set to 0 on every size; eBay ends the listing' }, by: ctx.by });
  }
  return { sent, endedByZero: ends.length };
}

async function pushPrice(ctx, changes, total) {
  const { io } = ctx;
  if (!changes.length || ctx.settings.switches.price === 'off') return { sent: 0 };
  if (!(await liveNow(ctx, 'price'))) {
    const blast = blastCheck({ changes: changes.length, total, blastPct: ctx.settings.blastPct });
    await shadowOrDo(ctx, 'price', { action: 'set_price', after: { count: changes.length, blast, sample: changes.slice(0, 10).map((c) => ({ item: c.link.item_id, sku: c.link.sku, from: c.link.ebay_price, to: c.price })) } });
    return { sent: 0, would: changes.length };
  }
  // Locks and our reprice tool's history are read AGAIN right now: a lock added since the reconcile read them still wins.
  const [locked, edited] = await Promise.all([io.lockedItemIds([...new Set(changes.map((c) => c.link.item_id))]), io.repricedKeys()]);
  const due = changes.filter((c) => !locked.has(String(c.link.item_id)) && !edited.has(`${c.link.item_id}|${c.link.variation_key}`));
  if (!due.length) return { sent: 0 };
  const blast = await blastFor(ctx, 'price', 'set_price', due.length, total);
  if (blast.stop) {
    await blockWith(ctx, 'price', blast, 'eBay Sync stopped: price', `Prices would change on ${due.length} sizes (${blast.pct}% of ${blast.total} in the last hour; the limit is ${blast.blastPct}%). Nothing was sent.`);
    return { sent: 0, blocked: blast };
  }
  await ensureBudget(io, 'write');
  const by = new Map(due.map((c) => [c.link.link_key, c]));
  let sent = 0;
  for (let i = 0; i < due.length; i += CHUNK) {
    if (!(await liveNow(ctx, 'price'))) break;
    const results = await io.write.reviseEbayPrices(due.slice(i, i + CHUNK).map((c) => ({ key: c.link.link_key, itemId: c.link.item_id, sku: sizeOfLink(c.link), price: c.price })));
    for (const r of results) {
      const c = by.get(r.key);
      if (r.ok) sent++;
      await io.db.logAdd({ domain: 'price', action: 'set_price', mode: 'live', itemId: c.link.item_id, sku: c.link.sku, before: { price: c.link.ebay_price }, after: { price: c.price }, ok: !!r.ok, error: r.error || null, by: ctx.by });
    }
  }
  return { sent };
}

// End a listing whose Shopify product(s) went draft / archived / deleted. Shopify is re-read LIVE (the products,
// then every SKU) and so is the listing on eBay. SKUs that merely vanished from Shopify are NOT ended here:
// they stay with the eBay Listings "Not in Shopify" tab (api/ebay/end.js).
async function endListings(ctx, itemIds, listingTotal) {
  const { io } = ctx;
  if (!itemIds.length || ctx.settings.switches.end === 'off') return { ended: 0 };
  const live = await liveNow(ctx, 'end');
  const confirmed = [];
  for (const itemId of itemIds) {
    const links = await io.db.linksByItem(itemId);
    if (!links.length || links.some((l) => l.duplicate)) continue;
    const pids = [...new Set(links.map((l) => l.shopify_product_id).filter(Boolean))];
    if (!pids.length) continue;
    const st = await io.productsState(pids);
    if (st.error) continue;
    if (!pids.every((id) => st.products.get(id)?.status !== 'ACTIVE')) continue;
    if (live) {
      // A SKU on any ACTIVE product keeps the listing: the product may have been re-made.
      let refuse = null;
      for (const sku of links.map((l) => l.sku).filter(Boolean)) {
        const q = await io.stockForSku(sku);
        if (q.code === 'missing') continue;
        if (q.error || q.productStatus === 'ACTIVE') { refuse = q.error || `SKU ${sku} is on an active product`; break; }
      }
      if (refuse) continue;
      // And eBay's own view of the listing right now: every size it has must be one we know.
      try {
        const now = await io.fetchEbayItemContent(itemId);
        if (now.status && now.status !== 'Active') continue;
        const known = new Set(links.map((l) => l.sku));
        if ((now.variations || []).some((v) => !v.sku || !known.has(v.sku))) continue;
      } catch { continue; }
    }
    confirmed.push({ itemId, links, status: pids.map((id) => st.products.get(id)?.status || 'DELETED').join('/') });
  }
  if (!confirmed.length) return { ended: 0 };
  if (live) {
    const blast = await blastFor(ctx, 'end', 'end_listing', confirmed.length, Math.max(1, listingTotal));
    if (blast.stop) {
      await blockWith(ctx, 'end', blast, 'eBay Sync stopped: ending listings', `${confirmed.length} more listings would be ended (${blast.pct}% of ${blast.total} in the last hour; the limit is ${blast.blastPct}%). Nothing was ended.`);
      return { ended: 0, blocked: blast };
    }
  }
  let ended = 0;
  for (const c of confirmed) {
    const title = c.links[0].title;
    const skus = c.links.map((l) => l.sku).filter(Boolean).join(' ');
    const reason = `Shopify product is ${c.status.toLowerCase()}`;
    if (live) await ensureBudget(io, 'write');
    const res = await shadowOrDo(ctx, 'end', { action: 'end_listing', itemId: c.itemId, once: true, before: { title }, after: { reason } }, async () => {
      const out = await io.write.endEbayItem(c.itemId);
      await io.write.logEbayEnd({ itemId: c.itemId, title, skus, reason, ok: out.ok, error: out.error, by: 'eBay Sync' });
      if (out.ok) await io.db.dropListing(c.itemId);   // gone from our copy too, as the Not in Shopify tab does
      return out;
    });
    if (res?.ok) ended++;
  }
  return { ended, would: live ? 0 : confirmed.length };
}

/* ------------------------------------ reconcile ------------------------------------ */

export async function reconcilePass(ctx) {
  const { io } = ctx;
  let settings = ctx.settings;
  if (SWITCHES.every((k) => settings.switches[k] === 'off')) return { note: 'All switches are off.' };
  await requireConnections(io);
  await ensureBudget(io, 'read');
  const now = io.now();
  const st = await readState('reconcile', io);
  const profile = await profileOf(io);
  const ebay = await io.fetchActiveListings((t) => styleFromTitle(t));
  const shop = await io.allVariants();
  const light = shop?.error || shop?.truncated ? { products: [] } : await io.productsLight();
  const guard = !light.error && !light.truncated
    ? readGuard({ shopify: shop, lastShopifyCount: st.lastShopifyCount, ebayRows: ebay?.rows, lastEbayRows: st.lastEbayRows, products: light.products, lastProductCount: st.lastProductCount, acceptCounts: ctx.acceptCounts })
    : { ok: false, why: `The Shopify product list could not be read completely${light.error ? `: ${light.error}` : ''}.` };
  const abort = async (why, shrank = false) => {
    await patchState(io, 'reconcile', { aborted: { why, at: now.toISOString(), shrank, shopify: shop?.variants?.length ?? null, ebay: ebay?.rows?.length ?? null, products: light?.products?.length ?? null } });
    await io.alert(`read:${dayKey(now)}`, 'eBay Sync skipped a pass', `${why} Nothing was changed.${shrank ? ' If the new count is right, an admin can accept it with "Accept the new counts".' : ''}`);
    await io.db.logAdd({ domain: 'stock', action: 'read_abort', mode: (await liveNow(ctx, 'stock')) ? 'live' : 'shadow', ok: false, error: why, by: ctx.by });
    return { ok: false, aborted: true, note: why };
  };
  if (!guard.ok) return abort(guard.why, !!guard.shrank);
  const coll = await io.collectionIds(profile.collection || 'Footwear');
  if (coll.error || coll.truncated) return abort(`The ${profile.collection || 'Footwear'} collection could not be read completely${coll.error ? `: ${coll.error}` : ''}.`);

  const { links: raw, dupShopify, dupEbay } = buildLinks({ ebayRows: ebay.rows, variants: shop.variants });
  const itemIds = [...new Set(raw.map((l) => l.item_id).filter(Boolean))];
  const [locked, edited, prev] = await Promise.all([io.lockedItemIds(itemIds), io.repricedKeys(), io.db.linkPrev()]);
  const prevBy = new Map(prev.map((p) => [p.link_key, p]));
  const decided = raw.map((l) => decideLink(l, { shopifyComplete: true, lockedItems: locked, editedKeys: edited, uplift: profile.uplift || 0, prev: prevBy.get(l.link_key) || null }));
  const links = decided.map((d) => {
    const p = prevBy.get(d.link_key);
    return { ...d, qty_drift_since: driftSince(p?.qty_drift_since, d.stock?.action === 'set', now), price_drift_since: driftSince(p?.price_drift_since, d.price?.action === 'set', now) };
  });

  // What to send: only drift seen on an earlier pass too (DPL usually fixes within minutes).
  let stockChanges = links.filter((l) => l.stock?.action === 'set' && driftPersists(l.qty_drift_since, now, SETTLE_MIN)).map((l) => ({ link: l, qty: l.stock.target }));
  // Only a size that really follows Shopify is ever repriced; lock / repriced / manual sizes have price.action 'none' or a kept rule.
  const priceChanges = links.filter((l) => l.price?.action === 'set' && l.price_rule === 'follows_shopify' && driftPersists(l.price_drift_since, now, SETTLE_MIN)).map((l) => ({ link: l, price: l.price.target }));
  const onEbay = links.filter((l) => l.item_id).length;

  await io.db.replaceLinks(links.map(({ stock, price, base, ...row }) => row), now.toISOString());

  // products
  const prevProducts = await io.db.productPrev();
  const byProduct = new Map();
  for (const v of shop.variants) byProduct.set(v.productId, [...(byProduct.get(v.productId) || []), v]);
  const itemOf = new Map();
  for (const l of links) if (l.item_id && !l.duplicate && l.shopify_product_id && !itemOf.has(l.shopify_product_id)) itemOf.set(l.shopify_product_id, l);
  const activeItems = new Set(itemIds);
  // A listing that was on eBay at the last pass and is gone now, which nobody ended through this app: eBay ended it
  // (its last size sold, or went to 0). Only those are ever relisted automatically.
  const vanished = prevProducts.filter((p) => p.status === 'uploaded' && p.item_id && !activeItems.has(p.item_id)).map((p) => p.item_id);
  const endedByApp = vanished.length ? await io.db.endedByApp(vanished) : new Set();
  const endedByStockOf = new Set(prevProducts.filter((p) => vanished.includes(p.item_id) && !endedByApp.has(p.item_id)).map((p) => p.shopify_product_id));
  const products = [];
  for (const p of light.products) {
    const vs = byProduct.get(p.id) || [];
    const stocked = vs.filter((v) => Number(v.qty) > 0 && String(v.sku || '').trim());
    const link = itemOf.get(p.id);
    const eligible = p.status === 'ACTIVE' && coll.ids.has(p.id) && stocked.length > 0;
    if (!link && !eligible && !prevProducts.some((x) => x.shopify_product_id === p.id && x.item_id && x.ended_by_stock)) continue;
    const kept = {};
    for (const l of links) if (l.shopify_product_id === p.id && l.item_id && l.sku && String(l.price_rule || '').startsWith('kept') && l.ebay_price != null) kept[l.sku] = l.ebay_price;
    products.push({
      id: p.id, title: p.title, style: styleFromTitle(p.title) || null, handle: p.handle, vendor: p.vendor, shopify_status: p.status, image: p.image,
      sizes: stocked.length, qty: stocked.reduce((n, v) => n + Number(v.qty), 0), eligible, uploaded: !!link, item_id: link?.item_id || null,
      view_url: link?.view_url || null, shopify_key: productKey(p.updatedAt, stocked.map((v) => v.sku)),
      last_prices: Object.keys(kept).length ? kept : null, ended_by_stock: endedByStockOf.has(p.id),
    });
  }
  await io.db.upsertProducts(products, now.toISOString());

  // ending: a product that is no longer ACTIVE (or is gone) with a live listing
  const statusOf = new Map(light.products.map((p) => [p.id, p.status]));
  const endItems = [...new Set(links.filter((l) => l.item_id && !l.duplicate && l.shopify_product_id && statusOf.get(l.shopify_product_id) !== 'ACTIVE').map((l) => l.item_id))];
  const ends = await endListings(ctx, endItems, Math.max(1, itemIds.length));

  // stock: read each size's quantity from Shopify LIVE right before it goes out (the reconcile read is minutes old)
  if (await liveNow(ctx, 'stock')) {
    const verified = [];
    for (const c of stockChanges.slice(0, MAX_LIVE_STOCK_READS)) {
      const q = await liveQty(io, c.link.sku);
      if (q == null) continue;                     // no levels / untracked / unreadable: never send 0 from that
      if (q !== c.link.ebay_qty) verified.push({ link: c.link, qty: q });
    }
    stockChanges = verified;
  }
  const stock = await pushStock(ctx, stockChanges, Math.max(1, onEbay), Math.max(1, itemIds.length));
  const price = await pushPrice(ctx, priceChanges, Math.max(1, onEbay));
  await patchState(io, 'reconcile', {
    lastShopifyCount: shop.variants.length, lastEbayRows: ebay.rows.length, lastProductCount: light.products.length, firstAt: st.firstAt || now.toISOString(),
    dupSkus: [...new Set([...dupShopify, ...dupEbay])].slice(0, 500), aborted: null,
  });
  io.db.prune?.().catch?.(() => {});
  await io.flushBudget?.();
  return { note: `${onEbay} sizes linked; stock ${stock.sent ?? 0} sent / ${stockChanges.length} due; price ${price.sent ?? 0} sent / ${priceChanges.length} due; ended ${ends.ended}`, stock, price, ends };
}

/* -------------------------------------- queue --------------------------------------- */

export async function queuePass(ctx) {
  const { io } = ctx;
  const rows = await io.db.claimQueue(MAX_QUEUE_CLAIM);
  if (!rows.length) return { idle: true, note: 'Queue empty.' };
  const stockLive = await liveNow(ctx, 'stock');
  const endLive = await liveNow(ctx, 'end');
  // In shadow the reconcile pass sees the same differences, so the queue just clears.
  if (!stockLive && !endLive) { await io.db.queueDone(rows.map((r) => r.id)); return { idle: true, note: `${rows.length} queued change(s) left to the reconcile pass (not live).` }; }
  if (!(await io.shopifyReady()) || !(await io.ebayReady())) return { idle: true, note: 'Not connected; kept for later.' };
  const [total, listingTotal] = [Math.max(1, await io.db.linkCount()), Math.max(1, await io.db.listingCount())];
  const failed = new Set();
  const changes = [];
  if (stockLive) {
    for (const sku of [...new Set(rows.filter((r) => r.kind === 'sku').map((r) => r.key))]) {
      try {
        const links = await io.db.linksBySku(sku);
        if (!links.length) continue;
        const qty = await liveQty(io, sku);
        if (qty == null) continue;                  // Shopify can't say: nothing is sent, and nothing is zeroed
        for (const link of links) if (link.ebay_qty !== qty) changes.push({ link, qty });
      } catch (e) { failed.add(sku); console.error(`[ebay-sync] queue SKU ${sku}: ${e.message}`); }   // only this SKU's rows stay
    }
    if (changes.length) await pushStock(ctx, changes, total, listingTotal);
  }
  let endFailed = false;
  if (endLive) {
    try {
      const pids = [...new Set(rows.filter((r) => r.kind !== 'sku').map((r) => r.key))];
      const items = await io.db.itemsOfProducts(pids);
      if (items.length) await endListings(ctx, items, listingTotal);
    } catch (e) { endFailed = true; console.error(`[ebay-sync] queue end: ${e.message}`); }
  }
  await io.db.queueDone(rows.filter((r) => (r.kind === 'sku' ? !failed.has(r.key) : !endFailed)).map((r) => r.id));
  return { note: `${rows.length} queued change(s); ${changes.length} stock change(s)${failed.size ? `; ${failed.size} SKU(s) kept for retry` : ''}.` };
}

/* -------------------------------------- content -------------------------------------- */

export async function contentPass(ctx) {
  const { io } = ctx;
  if (ctx.settings.switches.content === 'off') return { note: 'Content is off.' };
  await requireConnections(io);
  await ensureBudget(io, 'read', CONTENT_STOP);   // content has its own, lower stop: it must never starve the reconcile
  const profile = await profileOf(io);
  const cst = await readState('content', io);
  const today = dayKey(io.now());
  const swept = cst.sweepDay === today ? Number(cst.sweepN) || 0 : 0;
  const todo = await io.db.toCheck(MAX_CONTENT_PER_PASS, Math.max(0, CONTENT_SWEEP_PER_DAY - swept));
  if (!todo.length) return { idle: true, note: 'Nothing to check.' };
  const dupSkus = new Set((await readState('reconcile', io)).dupSkus || []);
  const full = await io.productsFull(todo.map((t) => t.shopify_product_id));
  if (full.error) throw new Error(full.error);
  const byId = new Map(full.products.map((p) => [p.id, p]));
  const nowIso = io.now().toISOString();
  const revises = [];
  let checked = 0; let refused = 0;
  for (const row of todo) {
    const mark = { content_checked_at: nowIso, content_key: row.shopify_key };
    const product = byId.get(row.shopify_product_id);
    if (!product || product.status !== 'ACTIVE') { await io.db.patchProduct(row.shopify_product_id, mark); continue; }
    let content;
    try { content = await io.fetchEbayItemContent(row.item_id); } catch (e) {
      if (e.budget) throw e;
      await io.db.patchProduct(row.shopify_product_id, { ...mark, drift: null });
      continue;
    }
    checked++;
    // Every size on the listing must belong to THIS product and be unique, or the listing could be pinned to another shoe.
    const own = new Set(product.variants.map((v) => v.sku));
    if ((content.variations || []).some((v) => !own.has(v.sku) || dupSkus.has(v.sku))) {
      refused++;
      await io.db.patchProduct(row.shopify_product_id, { ...mark, drift: null });
      continue;
    }
    const built = buildListing(product, profile);
    built.variations = built.variations.filter((v) => !dupSkus.has(v.sku));   // a shared SKU is never added as a new size
    const diff = contentDiff(content, built);
    await io.db.patchProduct(row.shopify_product_id, { ...mark, drift: diff.drift ? diff : null });
    if (diff.drift) revises.push({ row, built, diff });
  }
  await patchState(io, 'content', { sweepDay: today, sweepN: swept + todo.filter((t) => t.pri === 1).length });
  const listingTotal = Math.max(1, (await io.db.productTabs()).uploaded || 0);
  let revised = 0;
  for (const r of revises) {
    const itemId = r.row.item_id;
    const base = { action: 'revise', itemId, once: true, before: { fields: r.diff.fields }, after: { fields: r.diff.fields, title: r.diff.title, addSizes: r.diff.addSizes } };
    if (!(await liveNow(ctx, 'content'))) { await shadowOrDo(ctx, 'content', base); continue; }
    const blast = await blastFor(ctx, 'content', 'revise', 1, listingTotal);
    if (blast.stop) { await blockWith(ctx, 'content', blast, 'eBay Sync stopped: content', `Listings are being revised faster than the limit (${blast.pct}% of ${blast.total} in the last hour; limit ${blast.blastPct}%). Nothing more was changed.`); return { ok: false, note: `Blast stop at ${revised} revises.` }; }
    await ensureBudget(io, 'write');
    const res = await withLock(`item:${itemId}`, async () => {
      const data = {};
      if (r.diff.fields.includes('title')) data.title = r.built.title;
      if (r.diff.fields.includes('description')) data.description = r.built.description;
      if (r.diff.fields.includes('pictures')) data.pictures = r.built.pictures;
      if (r.diff.fields.includes('sizes')) {
        // Read the listing again NOW. Only NEW sizes go in the request (existing ones are never re-sent: their quantity
        // would gain what they already sold), plus the size set made of every value already there and the new ones.
        const fresh = await io.fetchEbayItemContent(itemId);
        const have = new Set((fresh.variations || []).map((v) => v.sku));
        const add = r.built.variations.filter((v) => !have.has(v.sku));
        if (!add.length && Object.keys(data).length === 0) return { ok: true, skipped: true };
        if (add.length) {
          data.variations = add;
          data.sizeValues = [...new Set([...(fresh.specificsSet?.values || []), ...add.map((v) => v.size)])];
          data.sizeName = fresh.specificsSet?.name || r.built.sizeName;
        }
      }
      data.invocationId = md5(`${itemId}|${r.row.shopify_key}|${r.diff.fields.join(',')}`);
      return shadowOrDo(ctx, 'content', base, () => io.write.reviseFixedPriceItem(itemId, data));
    });
    if (res?.ok && !res.skipped) revised++;
    else if (res && res.ok === false && !res.skipped) await io.db.patchProduct(r.row.shopify_product_id, { issues: translateEbayErrors(res.errors?.length ? res.errors : res.error) });
  }
  return { note: `${checked} listing(s) checked, ${revises.length} differ, ${revised} revised${refused ? `, ${refused} refused (a size belongs to another product)` : ''}.` };
}

/* -------------------------------------- create --------------------------------------- */

// One fresh look at eBay before listing anything: a SKU or style code already there means DPL (or a person) got there first.
async function freshOnEbay(io) {
  const f = await io.fetchActiveListings((t) => styleFromTitle(t));
  return { skus: new Set(f.rows.map((r) => r.sku).filter(Boolean)), styles: new Set(f.rows.map((r) => String(r.style || '').toUpperCase()).filter(Boolean)) };
}
const alreadyOnEbay = (listing, on) => listing.variations.some((v) => on.skus.has(v.sku)) || (listing.style && on.styles.has(String(listing.style).toUpperCase()));

// Quantities and prices for a relist: Shopify's live available number; a price we don't own stays what it was.
function relistData(listing, row) {
  const kept = row.last_prices || {};
  return { ...listing, variations: listing.variations.map((v) => (kept[v.sku] != null ? { ...v, price: Number(kept[v.sku]) } : v)) };
}

export async function createPass(ctx) {
  const { io } = ctx;
  if (ctx.settings.switches.create === 'off') return { note: 'Create is off.' };
  await requireConnections(io);
  await ensureBudget(io, 'read');
  const profile = await profileOf(io);
  const st = await readState('reconcile', io);
  const dupSkus = new Set([...(st.dupSkus || []), ...(await io.db.ebaySkus())]);
  const nowIso = io.now().toISOString();
  // 1. precheck + eBay's dry run (no listing, no fee: allowed in shadow too)
  const toVerify = await io.db.toVerify(MAX_VERIFY_PER_PASS);
  let verified = 0;
  if (toVerify.length) {
    const full = await io.productsFull(toVerify.map((p) => p.shopify_product_id));
    if (full.error) throw new Error(full.error);
    const byId = new Map(full.products.map((p) => [p.id, p]));
    for (const row of toVerify) {
      const product = byId.get(row.shopify_product_id);
      if (!product) continue;
      const listing = buildListing(product, profile);
      let issues = precheck(product, listing, { dupSkus });
      if (!issues.length && !row.item_id) {
        const v = await io.verifyAddFixedPriceItem(listing);
        if (v.budget) throw new Error('Trading budget reached');
        if (!v.ok) issues = translateEbayErrors(v.errors?.length ? v.errors : v.error);
      }
      verified++;
      const same = JSON.stringify(row.issues || []) === JSON.stringify(issues);
      await io.db.patchProduct(row.shopify_product_id, {
        issues, status: issues.length ? 'needs_attention' : 'not_uploaded', verify_key: row.shopify_key, verify_ok: issues.length === 0, verified_at: nowIso,
      });
      if (!same) await io.db.logAdd({ domain: 'create', action: 'verify', mode: (await liveNow(ctx, 'create')) ? 'live' : 'shadow', itemId: row.shopify_product_id, after: { issues }, ok: issues.length === 0, error: issues[0]?.message || null, by: ctx.by });
    }
  }
  // 2. list the verified ones (live only; capped per day, a relist counts too)
  const liveCreate = await liveNow(ctx, 'create');
  const doneToday = (await io.db.liveToday('create', 'add')) + (await io.db.liveToday('create', 'relist'));
  const room = Math.max(0, MAX_CREATE_PER_DAY - doneToday);
  const cands = await io.db.toAdd(liveCreate ? room : MAX_CREATE_PER_DAY);
  let added = 0;
  if (cands.length) {
    const full = await io.productsFull(cands.map((c) => c.shopify_product_id));
    if (full.error) throw new Error(full.error);
    const byId = new Map(full.products.map((p) => [p.id, p]));
    const onEbay = liveCreate ? await freshOnEbay(io) : null;
    for (const row of cands) {
      const product = byId.get(row.shopify_product_id);
      if (!product || product.status !== 'ACTIVE') continue;
      const listing = buildListing(product, profile);
      const issues = precheck(product, listing, { dupSkus });
      if (issues.length) { await io.db.patchProduct(row.shopify_product_id, { issues, status: 'needs_attention', verify_ok: false }); continue; }
      if (onEbay && alreadyOnEbay(listing, onEbay)) {
        await io.db.logAdd({ domain: 'create', action: 'skip_already_on_ebay', mode: 'live', itemId: row.shopify_product_id, after: { style: listing.style }, ok: false, error: 'A SKU or the style code is already on eBay.', by: ctx.by });
        continue;
      }
      const relist = !!row.item_id;
      if (liveCreate) await ensureBudget(io, 'write');
      const uuid = md5(`${row.shopify_product_id}|${row.shopify_key}|${row.item_id || ''}`);
      const res = await withLock(`product:${row.shopify_product_id}`, () => shadowOrDo(ctx, 'create', { action: relist ? 'relist' : 'add', itemId: row.shopify_product_id, once: true, after: { title: listing.title, sizes: listing.variations.length, relist } },
        () => (relist ? io.write.relistFixedPriceItem(row.item_id, { ...relistData(listing, row), uuid }) : io.write.addFixedPriceItem({ ...listing, uuid }))));
      if (res?.ok) {
        added++;
        if (relist) await io.db.moveItemId(row.item_id, res.itemId);   // locks and our reprice history follow the new id
        await io.db.patchProduct(row.shopify_product_id, { item_id: res.itemId, view_url: `https://www.ebay.com/itm/${res.itemId}`, status: 'uploaded', issues: [], verify_ok: null, ended_by_stock: false });
      } else if (res?.ok === false && !res.skipped) {
        await io.db.patchProduct(row.shopify_product_id, { issues: translateEbayErrors(res.errors?.length ? res.errors : res.error), status: 'needs_attention', verify_ok: false });
      }
    }
  }
  return { note: `${verified} verified, ${added} listed${liveCreate ? '' : ' (shadow: none)'}.` };
}

/* --------------------------------------- runner --------------------------------------- */

const RUN = { queue: queuePass, reconcile: reconcilePass, content: contentPass, create: createPass };
const running = new Set();
export const passRunning = (name) => running.has(name);
export async function runPass(name, { by = 'auto', io = IO, acceptCounts = false } = {}) {
  if (!RUN[name]) return { ok: false, error: `Unknown pass ${name}` };
  if (running.has(name)) return { ok: true, skipped: true };
  running.add(name);
  const started = Date.now();
  try {
    if (!io.dbReady()) return { ok: false, skipped: true };
    const settings = await readSettings(io);
    const res = (await RUN[name]({ io, settings, by, acceptCounts })) || {};
    // A queue pass that found nothing writes nothing: it would otherwise be a database write every 30 seconds.
    if (!res.idle) await patchState(io, name, { at: io.now().toISOString(), ok: res.ok !== false, note: res.note || '', ms: Date.now() - started });
    return { ok: res.ok !== false, ...res };
  } catch (e) {
    await patchState(io, name, { at: io.now().toISOString(), ok: false, note: e.message, ms: Date.now() - started }).catch(() => {});
    if (e.notConnected || /not authori[sz]ed|auth|token|expired|revoked/i.test(e.message)) {
      await io.alert(`auth:${dayKey(io.now())}`, 'eBay Sync lost its connection', e.message).catch(() => {});
    }
    return { ok: false, error: e.message };
  } finally { running.delete(name); }
}

/* --------------------------------------- status --------------------------------------- */

export async function buildStatus(io = IO) {
  const settings = await readSettings(io);
  const passes = {};
  for (const p of PASSES) { const s = await readState(p, io); passes[p] = { at: s.at || null, ok: s.ok ?? null, note: s.note || '', running: running.has(p), ...(p === 'reconcile' ? { aborted: s.aborted || null } : {}) }; }
  const rec = await readState('reconcile', io);
  const [products, listings, facts, queue, contentLive, createLive, budget] = await Promise.all([
    ebaySyncProductTabs(), ebaySyncListingTabs(), ebaySyncFacts(), ebaySyncQueueCount(),
    ebaySyncLiveDone('content', 'revise'), ebaySyncLiveDone('create', 'add'), tradingUsage(),
  ]);
  const ebay = await ebayStatus().catch(() => ({}));
  const observedDays = rec.firstAt ? Math.floor((io.now().getTime() - new Date(rec.firstAt).getTime()) / 86400_000) : 0;
  return {
    settings, passes, budget: { used: budget.used, limit: budget.limit, resetAt: budget.resetAt, readStop: budget.readStop, writeStop: budget.writeStop },
    writes_enabled: writesAllowed(),
    counts: { products, listings, queue, linked: facts.linked, duplicates: facts.duplicates, no_shopify: facts.no_shopify, needs_attention: facts.needs_attention },
    ebay: { connected: !!ebay.connected, user: ebay.user || null },
    facts: { ...facts, contentLive, createLive, observedDays },
    handover: handoverChecklist({ observedDays, qtyDrift: facts.qty_drift, priceDrift: facts.price_drift, contentLive, createLive }),
  };
}

// A person asked for one product to be verified / listed / relisted now.
export async function productAction(productId, action, { by, io = IO } = {}) {
  const ctx = { io, settings: await readSettings(io), by };
  if (['list', 'relist'].includes(action)) {
    if (!(await liveNow(ctx, 'create'))) {
      return { ok: false, error: ctx.settings.kill ? 'The kill switch is on, so nothing is sent to eBay.' : ctx.settings.switches.create !== 'live' ? 'New listings are not live. Turn the Create switch to Live first; Verify still works.' : 'This server is not allowed to write to eBay (it is not production).' };
    }
    if (passRunning('create')) return { ok: false, error: 'The listing pass is running right now; try again in a minute.' };
  }
  const full = await io.productsFull([productId]);
  if (full.error) return { ok: false, error: full.error };
  const product = full.products[0];
  if (!product) return { ok: false, error: 'Shopify no longer has this product.' };
  if (['list', 'relist'].includes(action) && product.status !== 'ACTIVE') return { ok: false, error: 'The product is not active in Shopify.' };
  const profile = await profileOf(io);
  const dupSkus = new Set([...((await readState('reconcile', io)).dupSkus || []), ...(await io.db.ebaySkus())]);
  const listing = buildListing(product, profile);
  let issues = precheck(product, listing, { dupSkus });
  const row = (await io.db.productPrev()).find((p) => p.shopify_product_id === productId);
  if (!issues.length && action === 'verify') {
    const v = await io.verifyAddFixedPriceItem(listing);
    if (!v.ok) issues = translateEbayErrors(v.errors?.length ? v.errors : v.error);
  }
  if (action === 'verify') {
    await io.db.patchProduct(productId, { issues, status: issues.length ? 'needs_attention' : 'not_uploaded', verify_ok: issues.length === 0, verified_at: io.now().toISOString() });
    return { ok: true, issues };
  }
  if (action === 'relist' && !row?.item_id) return { ok: false, error: 'This product has no earlier eBay listing to relist. Use List instead.' };
  if (issues.length) return { ok: false, issues, error: issues[0].message };
  const on = await freshOnEbay(io);
  if (alreadyOnEbay(listing, on)) return { ok: false, error: 'A size (SKU) or the style code of this shoe is already on eBay, so it was not listed again.' };
  await ensureBudget(io, 'write');
  const relist = action === 'relist';
  const uuid = md5(`${productId}|manual|${row?.item_id || ''}|${listing.variations.map((v) => v.sku).join(',')}`);
  const res = await withLock(`product:${productId}`, () => shadowOrDo(ctx, 'create', { action: relist ? 'relist' : 'add', itemId: productId, after: { title: listing.title, manual: true } },
    () => (relist ? io.write.relistFixedPriceItem(row.item_id, { ...relistData(listing, row), uuid }) : io.write.addFixedPriceItem({ ...listing, uuid }))));
  if (res?.ok) {
    if (relist) await io.db.moveItemId(row.item_id, res.itemId);
    await io.db.patchProduct(productId, { item_id: res.itemId, view_url: `https://www.ebay.com/itm/${res.itemId}`, status: 'uploaded', issues: [], ended_by_stock: false });
    return { ok: true, itemId: res.itemId };
  }
  if (res?.skipped) return { ok: false, error: res.error };
  const out = translateEbayErrors(res?.errors?.length ? res.errors : res?.error);
  await io.db.patchProduct(productId, { issues: out, status: 'needs_attention', verify_ok: false });
  return { ok: false, issues: out, error: out[0]?.message };
}
