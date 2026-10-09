// Pre-sell Listings — the platform-neutral core (docs/context/presell-listings.md).
//
// One shape for both marketplaces: create / activate / deactivate / update / delete /
// refresh a listing, each answering
//   { ok, status, platform_status?, price_cents?, size_value?, pending_op?, raw?, error? }
// where `status` is OURS: pending · live · off · sold · deleted · failed.
//   · Alias answers synchronously — never `pending`.
//   · StockX answers "accepted" with an operation id — `pending` until the worker
//     (presell-worker.js) sees the operation succeed or fail.
// A sale (from the worker's order polls) is recorded ONCE, deducts the stock row, takes
// down listings the stock can no longer cover, and posts to the pre-sell Telegram group.
import {
  aliasCreateListing, aliasGetListing, aliasUpdateListing, aliasActivateListing, aliasDeactivateListing,
  aliasDeleteListing, aliasListingError,
} from './alias.js';
import {
  stockxCreateListing, stockxGetListing, stockxUpdateListing, stockxActivateListing, stockxDeactivateListing,
  stockxDeleteListing, stockxListingOperation, stockxError,
} from './stockx.js';
import {
  getPresellStock, openPresellListings, updatePresellListing, recordPresellSale, markPresellSaleNotified,
} from './db.js';
import { sendPresellSale } from './telegram.js';

export const PLATFORM_LABEL = { alias: 'Alias', stockx: 'StockX' };

/* ------------------------------ status maps ------------------------------ */
const ALIAS_STATUS = {
  LISTING_STATUS_ACTIVE: 'live', LISTING_STATUS_INACTIVE: 'off', LISTING_STATUS_DELETED: 'deleted',
};
const aliasStatus = (s) => ALIAS_STATUS[s] || (/SOLD|ORDER/i.test(String(s)) ? 'sold' : 'off');
const STOCKX_STATUS = {
  ACTIVE: 'live', INACTIVE: 'off', DELETED: 'deleted', CANCELED: 'deleted', MATCHED: 'sold', COMPLETED: 'sold',
};
const stockxStatus = (s) => STOCKX_STATUS[s] || 'off';
// StockX amounts are whole-dollar STRINGS ("136"); Alias's are cents strings.
const sxCents = (a) => (a == null || a === '' ? null : Math.round(Number(a) * 100));

/* ------------------------------- Alias ---------------------------------- */
function aliasOut(r) {
  if (!r.ok) return { ok: false, error: aliasListingError(r), notFound: r.status === 404 };
  const l = r.data?.listing;
  return {
    ok: true, external_id: l?.id, status: l ? aliasStatus(l.status) : undefined, platform_status: l?.status,
    price_cents: l?.price_cents != null ? Number(l.price_cents) : undefined,
    size_value: l?.size != null ? Number(l.size) : undefined, raw: l || undefined,
  };
}
const alias = {
  async create({ catalogRef, sizeValue, priceCents, active }) {
    return aliasOut(await aliasCreateListing({ catalogId: catalogRef, priceCents, size: sizeValue, activate: active }));
  },
  async activate(l) { const o = aliasOut(await aliasActivateListing(l.external_id)); if (o.ok && !o.status) o.status = 'live'; return o; },
  async deactivate(l) { const o = aliasOut(await aliasDeactivateListing(l.external_id)); if (o.ok && !o.status) o.status = 'off'; return o; },
  async update(l, { priceCents, sizeValue }) { return aliasOut(await aliasUpdateListing(l.external_id, { priceCents, size: sizeValue })); },
  async remove(l) { const o = aliasOut(await aliasDeleteListing(l.external_id)); if (o.ok) o.status = 'deleted'; return o; },
  async refresh(l) { return aliasOut(await aliasGetListing(l.external_id)); },
};

/* ------------------------------- StockX --------------------------------- */
// Every StockX write comes back PENDING with an operation to watch.
function sxAccepted(r, action) {
  if (!r.ok) return { ok: false, error: stockxError(r), notFound: r.status === 404 };
  const d = r.data || {};
  if (d.operationStatus === 'FAILED') return { ok: false, error: d.error || `StockX refused the ${action}.` };
  return {
    ok: true, external_id: d.listingId, status: d.operationStatus === 'SUCCEEDED' ? undefined : 'pending',
    pending_op: d.operationStatus === 'SUCCEEDED' ? null : d.operationId, pending_action: action, raw: d,
  };
}
// StockX sometimes finishes an operation before answering (operationStatus SUCCEEDED);
// then there's nothing to wait for — read the listing back for its real state now.
async function sxSettle(out, externalId) {
  if (!out.ok || out.pending_op) return out;
  const back = await stockx.refresh({ external_id: out.external_id || externalId });
  return back.ok ? { ...back, external_id: out.external_id || externalId, pending_op: null, pending_action: null } : { ...out, pending_op: null, pending_action: null };
}
const stockx = {
  async create({ variantId, priceCents, active }) {
    return sxSettle(sxAccepted(await stockxCreateListing({ variantId, amount: Math.round(priceCents / 100), active }), active ? 'create_live' : 'create_off'));
  },
  // An INACTIVE StockX listing has no ask; activating carries the price we hold for it.
  async activate(l) { return sxSettle(sxAccepted(await stockxActivateListing(l.external_id, Math.round(Number(l.price_cents) / 100)), 'activate'), l.external_id); },
  async deactivate(l) { return sxSettle(sxAccepted(await stockxDeactivateListing(l.external_id), 'deactivate'), l.external_id); },
  async update(l, { priceCents }) { return sxSettle(sxAccepted(await stockxUpdateListing(l.external_id, Math.round(priceCents / 100)), 'update'), l.external_id); },
  async remove(l) {
    const out = sxAccepted(await stockxDeleteListing(l.external_id), 'delete');
    return out.ok && !out.pending_op ? { ...out, status: 'deleted', pending_op: null, pending_action: null } : out;
  },
  async refresh(l) {
    const r = await stockxGetListing(l.external_id);
    if (!r.ok) return { ok: false, error: stockxError(r), notFound: r.status === 404 };
    const d = r.data || {};
    return { ok: true, status: stockxStatus(d.status), platform_status: d.status, price_cents: sxCents(d.amount) ?? undefined, raw: d };
  },
  // The worker: has StockX finished what we asked?
  async operation(l) {
    const r = await stockxListingOperation(l.external_id, l.pending_op);
    if (!r.ok) return { ok: false, error: stockxError(r) };
    return { ok: true, opStatus: r.data?.operationStatus, error: r.data?.error || null };
  },
};

export const PLATFORMS = { alias, stockx };

// Apply a platform answer to our row. Returns the patch that was written.
export async function applyResult(listing, out, actor, extra = {}) {
  const patch = { ...extra };
  if (!out.ok) {
    patch.last_error = out.error;
    await updatePresellListing(listing.id, patch, actor);
    return patch;
  }
  for (const k of ['status', 'platform_status', 'price_cents', 'size_value', 'raw', 'pending_op', 'pending_action']) {
    if (out[k] !== undefined) patch[k] = out[k];
  }
  patch.last_error = null;
  await updatePresellListing(listing.id, patch, actor);
  return patch;
}

/* ------------------------- stock: never oversell ------------------------- */
// After a sale (or a quantity cut): pairs left = qty − sold. A platform may not hold more
// open listings than that, so the newest extras come down — on BOTH platforms.
export async function reconcileStock(stockId, actor = 'system') {
  const stock = await getPresellStock(stockId);
  if (!stock) return [];
  const left = Math.max(0, Number(stock.qty) - Number(stock.sold));
  const open = await openPresellListings(stockId);
  const removed = [];
  for (const platform of Object.keys(PLATFORMS)) {
    const mine = open.filter((l) => l.platform === platform);
    for (const l of mine.slice(0, Math.max(0, mine.length - left))) {
      try {
        const out = await PLATFORMS[platform].remove(l);
        await applyResult(l, out, actor);
        removed.push({ platform, id: l.id, ok: out.ok, error: out.error });
      } catch (e) {
        await updatePresellListing(l.id, { last_error: `Take-down failed: ${e.message}` }, actor);
        removed.push({ platform, id: l.id, ok: false, error: e.message });
      }
    }
  }
  return removed;
}

/* -------------------------------- a sale --------------------------------- */
const money = (cents) => (cents == null ? '—' : `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);

export async function handleSale({ listing, platform, orderId, priceCents, payoutCents, soldAt, raw }) {
  const saleId = await recordPresellSale({ listing, platform, orderId, priceCents, payoutCents, soldAt, raw }, 'system');
  if (!saleId) return null;   // already recorded
  const removed = await reconcileStock(listing.stock_id, 'system');
  const stock = await getPresellStock(listing.stock_id);
  const left = Math.max(0, Number(stock?.qty || 0) - Number(stock?.sold || 0));
  const lines = [
    `💰 SOLD on ${PLATFORM_LABEL[platform]}`,
    { b: stock?.name || stock?.sku || 'Pre-sell pair' },
    `${stock?.sku || ''} · size ${stock?.size || '?'}`,
    `Price: ${money(priceCents)}${payoutCents != null ? ` (payout ${money(payoutCents)})` : ''}`,
    `Order: ${orderId}`,
    `Pre-sell stock left: ${left} of ${stock?.qty ?? '?'}`,
  ];
  // Listed while still on its way (presell-arrival.js) — the pair isn't in the warehouse yet.
  // The pair is still on the truck: when the shipment lands, the warehouse sets it aside for
  // this buyer and does NOT inbound it, so PH lists only the rest (owner, 2026-10-10).
  if (stock?.in_transit && !stock?.arrived_at) {
    lines.splice(1, 0, `🚚 IN TRANSIT${stock.expected_on ? ` — expected ${String(stock.expected_on).slice(0, 10)}` : ''}${stock.transit_note ? ` · ${stock.transit_note}` : ''}`);
    lines.push(`Warehouse: when it arrives, set ${Number(stock.sold) === 1 ? '1 pair' : `${stock.sold} pairs`} of size ${stock.size} aside for the buyer${Number(stock.sold) === 1 ? '' : 's'} — don't inbound ${Number(stock.sold) === 1 ? 'it' : 'them'}. Inbound the other ${Math.max(0, Number(stock.qty) - Number(stock.sold))}.`);
  }
  const down = removed.filter((r) => r.ok);
  const stuck = removed.filter((r) => !r.ok);
  if (down.length) lines.push(`Taken down: ${down.map((r) => PLATFORM_LABEL[r.platform]).join(', ')} (${down.length})`);
  if (stuck.length) lines.push(`⚠️ Could NOT take down ${stuck.length} listing(s) — check them now: ${stuck.map((r) => `${PLATFORM_LABEL[r.platform]}: ${r.error}`).join('; ')}`);
  try {
    await sendPresellSale(lines);
    await markPresellSaleNotified(saleId);
  } catch (e) {
    console.error('[presell] sale message failed:', e.message);
    await markPresellSaleNotified(saleId, e.message);
  }
  return saleId;
}
