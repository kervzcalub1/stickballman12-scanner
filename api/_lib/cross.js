// Alias Cross-Listing — the server core (docs/context/alias-cross-listing.md).
//   topUpSku        list one SKU of a group up to the pairs left for a size
//   reconcilePool   take down what the pairs left can no longer cover (after a sale / a cut)
//   handleCrossSale one Alias order: recorded once, pool −1, the other SKUs' extras come
//                   down, and the cross-listing Telegram chat is told
// The Alias calls are passed in (`io`) so the money path can be tested without Alias.
import { aliasCreateListing, aliasDeleteListing, aliasUpdateListing, aliasListingError } from './alias.js';
import {
  getCrossPool, openCrossListings, insertCrossListing, updateCrossListing, recordCrossSale, markCrossSaleNotified,
  getCrossGroupSkus, getSetting,
} from './db.js';
import { sendToChat } from './telegram.js';
import { takeDownPlan, roomFor, pairsLeft, saleLines } from '../../src/lib/crossListing.js';

export const CHAT_KEY = 'cross_listing_chat_id';
export const crossChatId = async () => String((await getSetting(CHAT_KEY).catch(() => null)) || '').trim() || null;

const why = (e, what) => (e?.name === 'AbortError' || e?.name === 'TimeoutError' ? `Alias timed out — ${what}` : `Could not reach Alias: ${e?.message || 'network'}`);
const ALIAS = {
  async create({ catalogId, sizeValue, priceCents, active }) {
    const r = await aliasCreateListing({ catalogId, priceCents, size: sizeValue, activate: active });
    const l = r.data?.listing;
    return r.ok && l?.id ? { ok: true, external_id: l.id, price_cents: l.price_cents != null ? Number(l.price_cents) : priceCents } : { ok: false, error: aliasListingError(r) };
  },
  async remove(externalId) {
    const r = await aliasDeleteListing(externalId);
    // Already gone on Alias = down, which is what we wanted.
    return r.ok || r.status === 404 ? { ok: true } : { ok: false, error: aliasListingError(r) };
  },
  async price(externalId, priceCents) {
    const r = await aliasUpdateListing(externalId, { priceCents });
    return r.ok ? { ok: true } : { ok: false, error: aliasListingError(r) };
  },
};

// → { wanted, created, errors:[…] }
export async function topUpSku(pool, groupSku, { sizeValue, priceCents, active }, actor, io = ALIAS) {
  const open = await openCrossListings(pool.id);
  const wanted = roomFor(pool, open, groupSku.id);
  const out = { wanted, created: 0, errors: [] };
  for (let i = 0; i < wanted; i++) {
    try {
      const r = await io.create({ catalogId: groupSku.catalog_id, sizeValue, priceCents, active });
      if (!r.ok) { out.errors.push(r.error || 'Alias refused the listing.'); continue; }
      await insertCrossListing({ pool_id: pool.id, group_sku_id: groupSku.id, external_id: r.external_id, size_value: sizeValue, price_cents: r.price_cents ?? priceCents, status: active ? 'live' : 'off' }, actor);
      out.created++;
    } catch (e) {
      // A timeout is "don't know" — Alias may have made it; stop rather than list it twice.
      out.errors.push(why(e, 'check Alias before retrying, it may have been listed.'));
      break;
    }
  }
  return out;
}

// Take down the newest listings a pool can no longer cover, on every SKU. `only` limits it
// to some listings (the whole pool / one SKU being closed).
export async function reconcilePool(poolId, actor = 'system', reason = 'sold_other', io = ALIAS, { all = false, groupSkuId = null } = {}) {
  const pool = await getCrossPool(poolId);
  if (!pool) return [];
  let open = await openCrossListings(poolId);
  if (groupSkuId) open = open.filter((l) => Number(l.group_sku_id) === Number(groupSkuId));
  const down = all ? open : takeDownPlan(pairsLeft(pool), open);
  const removed = [];
  for (const l of down) {
    try {
      const r = await io.remove(l.external_id);
      await updateCrossListing(l.id, r.ok ? { status: 'deleted', delete_reason: reason, last_error: null } : { last_error: `Take-down failed: ${r.error}` }, actor);
      removed.push({ id: Number(l.id), sku: l.sku, ok: r.ok, error: r.error });
    } catch (e) {
      const msg = why(e, 'the listing may still be up.');
      await updateCrossListing(l.id, { last_error: `Take-down failed: ${msg}` }, actor);
      removed.push({ id: Number(l.id), sku: l.sku, ok: false, error: msg });
    }
  }
  return removed;
}

// Change the price of every open listing of one SKU for a size.
export async function repriceSku(poolId, groupSkuId, priceCents, actor, io = ALIAS) {
  const open = (await openCrossListings(poolId)).filter((l) => Number(l.group_sku_id) === Number(groupSkuId));
  const out = { changed: 0, errors: [] };
  for (const l of open) {
    try {
      const r = await io.price(l.external_id, priceCents);
      if (r.ok) { await updateCrossListing(l.id, { price_cents: priceCents, last_error: null }, actor); out.changed++; }
      else { await updateCrossListing(l.id, { last_error: `Price change failed: ${r.error}` }, actor); out.errors.push(r.error); }
    } catch (e) { out.errors.push(why(e, 'the price may not have changed.')); }
  }
  return out;
}

export async function handleCrossSale({ listing, orderId, priceCents, payoutCents, soldAt, raw }, { io = ALIAS, notify = null } = {}) {
  const saleId = await recordCrossSale({ listing, orderId, priceCents, payoutCents, soldAt, raw }, 'system');
  if (!saleId) return null;   // this order was already recorded
  const removed = await reconcilePool(listing.pool_id, 'system', 'sold_other', io);
  const pool = await getCrossPool(listing.pool_id);
  const skus = await getCrossGroupSkus(pool.group_id);
  const lines = saleLines({
    groupName: pool.group_name, sku: listing.sku, skuName: listing.sku_name, size: pool.size, orderId,
    price_cents: priceCents, payout_cents: payoutCents, unit_cost: pool.unit_cost, pool, removed,
    others: skus.filter((k) => Number(k.id) !== Number(listing.group_sku_id)).map((k) => k.sku),
  });
  try {
    if (notify) await notify(lines);
    else {
      const chat = await crossChatId();
      if (!chat) throw new Error('No Telegram chat is set for cross-listing sales.');
      await sendToChat(chat, lines);
    }
    await markCrossSaleNotified(saleId);
  } catch (e) {
    console.error('[cross-listing] sale message failed:', e.message);
    await markCrossSaleNotified(saleId, e.message);
  }
  return { saleId, removed };
}
