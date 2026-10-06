// Pre-sell Listings — the background watcher (docs/context/presell-listings.md).
//
// Two loops, started once by server.mjs when PRESELL_WATCH=on (set it on ONE environment:
// dev and prod share the same Alias and StockX accounts, and two watchers would both act):
//   · every 12 s — StockX operations still PENDING: done? → read the listing back for its
//     real state; failed → say why on the row. Quiet when nothing is pending.
//   · every 60 s — new orders on Alias (newest first) and StockX (active orders), matched
//     to OUR listings by the platform's listing id → handleSale (deduct, take down, Telegram).
//     Skipped entirely while we have nothing listed.
import { pendingPresellListings, presellListingsByExternal, presellHasOpenListings, updatePresellListing, getSetting, claimMarketplaceSale, markMarketplaceSaleAlerted } from './db.js';
import { sendPresellSale } from './telegram.js';
import { PLATFORMS, applyResult, handleSale } from './presell.js';
import { aliasRecentOrders } from './alias.js';
import { stockxActiveOrders, stockxConfigured } from './stockx.js';

const OPS_EVERY_MS = 12_000;
const SALES_EVERY_MS = 60_000;
const STUCK_AFTER_MS = 10 * 60_000;   // a StockX operation still pending after this is re-read
let started = false;

async function checkOperations() {
  const rows = await pendingPresellListings(25);
  for (const l of rows) {
    if (l.platform !== 'stockx') continue;
    try {
      const op = await PLATFORMS.stockx.operation(l);
      const stuck = l.pending_since && Date.now() - new Date(l.pending_since).getTime() > STUCK_AFTER_MS;
      if (op.ok && op.opStatus === 'PENDING' && !stuck) continue;
      if (op.ok && op.opStatus === 'FAILED') {
        if (String(l.pending_action).startsWith('create')) {
          await updatePresellListing(l.id, { status: 'failed', pending_op: null, pending_action: null, last_error: op.error || 'StockX refused the listing.' }, 'system');
          continue;
        }
        // A failed change leaves the listing as it was — read it back, keep the reason.
        const back = await PLATFORMS.stockx.refresh(l);
        await applyResult(l, back, 'system', { pending_op: null, pending_action: null });
        await updatePresellListing(l.id, { last_error: `StockX refused the ${l.pending_action}: ${op.error || 'no reason given'}` }, 'system');
        continue;
      }
      // Succeeded (or stuck): the listing itself is the truth.
      if (l.pending_action === 'delete' && op.ok && op.opStatus === 'SUCCEEDED') {
        await updatePresellListing(l.id, { status: 'deleted', pending_op: null, pending_action: null, last_error: null }, 'system');
        continue;
      }
      const back = await PLATFORMS.stockx.refresh(l);
      await applyResult(l, back, 'system', { pending_op: null, pending_action: null });
    } catch (e) {
      console.error('[presell-worker] operation check', l.id, e.message);
    }
  }
}

// Regular (non-pre-sell) sales → the same group, as a TEST (owner, 2026-10-07). On while
// app_settings.sales_alert_all_since holds the moment it was switched on; only orders
// placed after that alert (the 76 already open on StockX stay quiet), each once.
const usd = (cents) => (cents == null ? '—' : `$${(Number(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
async function alertRegularSale(platform, orderId, orderAt, since, lines) {
  if (!since || !orderAt || new Date(orderAt) < since) return;
  if (!(await claimMarketplaceSale(platform, orderId, orderAt))) return;
  try {
    await sendPresellSale([`🛒 SOLD on ${platform === 'alias' ? 'Alias' : 'StockX'} — regular stock (test alert)`, ...lines]);
    await markMarketplaceSaleAlerted(platform, orderId);
  } catch (e) {
    console.error('[presell-worker] regular sale alert', e.message);
    await markMarketplaceSaleAlerted(platform, orderId, e.message);
  }
}

async function checkSales() {
  const sinceRaw = await getSetting('sales_alert_all_since').catch(() => null);
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw) : null;
  if (!since && !(await presellHasOpenListings())) return;
  // Alias — newest orders first; each names the listing it sold from.
  try {
    const r = await aliasRecentOrders(50);
    const orders = (r.ok && Array.isArray(r.data?.results) ? r.data.results : [])
      .filter((o) => o.listing_id && !/CANCEL/i.test(o.status || ''));
    const mine = await presellListingsByExternal('alias', orders.map((o) => o.listing_id));
    for (const o of orders) {
      const l = mine.find((x) => x.external_id === o.listing_id);
      if (!l) {
        await alertRegularSale('alias', String(o.id), o.sold_at, since, [
          { b: o.catalog_name || o.catalog_sku || 'Alias sale' },
          `${String(o.catalog_sku || '').replace(/\s+/g, '-')} · size ${o.size ?? '?'}`,
          `Price: ${usd(o.price_cents)}${o.price_cents_after_take != null ? ` (payout ${usd(o.price_cents_after_take)})` : ''}`,
          `Order: ${o.id}`,
        ]);
        continue;
      }
      if (l.status === 'sold') continue;
      await handleSale({
        listing: l, platform: 'alias', orderId: String(o.id), priceCents: Number(o.price_cents) || null,
        payoutCents: o.price_cents_after_take != null ? Number(o.price_cents_after_take) : null, soldAt: o.sold_at || new Date().toISOString(), raw: o,
      });
    }
  } catch (e) { console.error('[presell-worker] alias orders', e.message); }
  // StockX — active orders carry the listingId.
  if (stockxConfigured()) {
    try {
      const r = await stockxActiveOrders(100);
      const orders = (r.ok && Array.isArray(r.data?.orders) ? r.data.orders : []).filter((o) => o.listingId);
      const mine = await presellListingsByExternal('stockx', orders.map((o) => o.listingId));
      for (const o of orders) {
        const l = mine.find((x) => x.external_id === o.listingId);
        if (!l) {
          const total = o.payout?.totalPayout;
          await alertRegularSale('stockx', String(o.orderNumber), o.createdAt, since, [
            { b: o.product?.productName || o.product?.styleId || 'StockX sale' },
            `${o.product?.styleId || ''} · size ${o.variant?.variantValue ?? '?'}`,
            `Price: ${o.amount != null ? `$${o.amount}` : '—'}${total != null ? ` (payout $${total})` : ''}`,
            `Order: ${o.orderNumber}`,
          ]);
          continue;
        }
        if (l.status === 'sold') continue;
        const payout = o.payout?.totalPayout ?? null;
        await handleSale({
          listing: l, platform: 'stockx', orderId: String(o.orderNumber), priceCents: o.amount != null ? Math.round(Number(o.amount) * 100) : null,
          payoutCents: payout != null ? Math.round(Number(payout) * 100) : null, soldAt: o.createdAt || new Date().toISOString(), raw: o,
        });
      }
    } catch (e) { console.error('[presell-worker] stockx orders', e.message); }
  }
}

// Never overlapping: a slow poll skips the next tick rather than stacking up.
function loop(fn, every, name) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(`[presell-worker] ${name}`, e.message); } finally { busy = false; }
  };
  setTimeout(tick, 5_000);
  return setInterval(tick, every);
}

export function startPresellWorker() {
  if (started) return;
  if (String(process.env.PRESELL_WATCH || '').trim().toLowerCase() !== 'on') {
    console.log('[presell-worker] off (set PRESELL_WATCH=on on ONE environment to watch sales + StockX operations)');
    return;
  }
  started = true;
  loop(checkOperations, OPS_EVERY_MS, 'operations');
  loop(checkSales, SALES_EVERY_MS, 'sales');
  console.log('[presell-worker] watching StockX operations every 12 s and Alias/StockX sales every 60 s');
}

// Exposed so an admin action / test can run one pass on demand.
export { checkOperations, checkSales };
