// In-transit pre-sell listings: when the pairs ARRIVE, the listings come down
// (docs/context/presell-listings.md → "In transit"). Alex, 2026-10-10: list a shipment on
// Alias + StockX while it's still on the truck to ride the hype; once the warehouse receives
// it, take those listings off so PH / Nikki can list the real pairs properly.
//
// Owner's calls: unsold listings are DELETED (not switched off); "arrived" = the warehouse
// receives that SKU + size in any batch (except Existing Stock, which is old stock counted
// in, not an arrival); pairs that SOLD in transit are only reported, not held.
//
// Runs ONLY where PRESELL_WATCH=on — the one environment allowed to act on the shared
// Alias / StockX accounts (presell-worker.js). Without that guard a receive on a laptop
// would delete live production listings.
import { presellTransitMatches, claimPresellArrival, batchKindAndCode, openPresellListings, updatePresellListing } from './db.js';
import { PLATFORMS, PLATFORM_LABEL, applyResult } from './presell.js';
import { sendPresellSale } from './telegram.js';

export const arrivalsEnabled = (env = process.env) => String(env.PRESELL_WATCH || '').trim().toLowerCase() === 'on';

// One arrived SKU + size: delete every open listing on both platforms, then post one
// message. Returns what happened, for the caller (and tests).
export async function takeDownArrived(stock, batchCode, { platforms = PLATFORMS, notify = sendPresellSale } = {}) {
  const open = await openPresellListings(stock.id);
  const removed = [];
  for (const l of open) {
    try {
      const out = await platforms[l.platform].remove(l);
      await applyResult(l, out, 'arrival');
      removed.push({ platform: l.platform, ok: out.ok, error: out.error });
    } catch (e) {
      await updatePresellListing(l.id, { last_error: `Take-down on arrival failed: ${e.message}` }, 'arrival');
      removed.push({ platform: l.platform, ok: false, error: e.message });
    }
  }
  const sold = Number(stock.sold || 0);
  const count = (p) => removed.filter((r) => r.ok && r.platform === p).length;
  const left = Math.max(0, Number(stock.qty) - sold);
  // Sections with a rule between them, like the sale post (owner, 2026-10-10).
  const RULE = '━━━━━━━━━━━━━━━━';
  const lines = [
    { b: '📦 INBOUNDED — in-transit pre-sell arrived, listings taken down' },
    '',
    { b: stock.name || stock.sku },
    `${stock.sku} · size ${stock.size}${batchCode ? ` · received in ${batchCode}` : ''}`,
    ...(stock.supplier ? [{ b: 'Supplier:', t: ` ${stock.supplier}` }] : []),
    ...(stock.po_code ? [{ b: 'PO:', t: ` ${stock.po_code}` }] : []),
    RULE,
    { b: 'Listings:', t: removed.some((r) => r.ok)
      ? ` deleted ${['alias', 'stockx'].filter((p) => count(p)).map((p) => `${PLATFORM_LABEL[p]} ${count(p)}`).join(', ')}`
      : ' nothing was still listed' },
    RULE,
    { b: sold ? '⚠️ WAREHOUSE' : '📦 WAREHOUSE' },
    sold
      ? `Sold while in transit: ${sold} of ${stock.qty}. Set those ${sold} aside for the buyer${sold === 1 ? '' : 's'} — inbound and list only ${left}.`
      : `Sold while in transit: 0 of ${stock.qty} — all ${stock.qty} can be inbounded and listed.`,
    'PH / Nikki: list the arrived pairs as usual.',
  ];
  const stuck = removed.filter((r) => !r.ok);
  if (stuck.length) lines.push(RULE, `⚠️ Could NOT delete ${stuck.length} listing(s) — take them down by hand: ${stuck.map((r) => `${PLATFORM_LABEL[r.platform]}: ${r.error}`).join('; ')}`);
  let notified = true;
  try { await notify(lines); } catch (e) { notified = false; console.error('[presell-arrival] message failed:', e.message); }
  return { stockId: stock.id, removed, sold, notified };
}

// Called by insertItems after every receive commit (fire-and-forget).
export async function onItemsReceived(batchId, items, opts = {}) {
  if (!(opts.enabled ?? arrivalsEnabled())) return [];
  const pairs = (items || []).filter((it) => it?.sku && it?.size).map((it) => ({ sku: it.sku, size: it.size }));
  if (!pairs.length) return [];
  const matches = await presellTransitMatches(pairs);
  if (!matches.length) return [];
  const batch = batchId ? await batchKindAndCode(batchId) : null;
  if (batch?.kind === 'existing') return [];
  const done = [];
  for (const m of matches) {
    const stock = await claimPresellArrival(m.id, batch?.batch_code);
    if (!stock) continue;   // another commit got there first
    done.push(await takeDownArrived(stock, batch?.batch_code, opts));
  }
  return done;
}
