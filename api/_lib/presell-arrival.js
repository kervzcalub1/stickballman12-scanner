// In-transit pre-sell: what happens when the pairs ARRIVE (docs/context/presell-listings.md →
// "In transit"). Alex, 2026-10-10: list a shipment on Alias + StockX while it's on the truck.
//
// BY THE PAIR (owner, 2026-10-11). The first build took ANY receive of the SKU + size as
// "arrived" and deleted every unsold listing — Brent received the first 37 of 213 Jordan 1
// Royal pairs and 162 pairs' listings came down. Now a receive only COUNTS:
//   · arrived pairs first cover pairs already SOLD in transit → set aside for those buyers;
//   · the rest are RELEASED to normal inventory for PH / Nikki to list;
//   · NOTHING is deleted here. A pre-sell listing comes down on a platform once PH has listed
//     a released pair there (AL / SX in the PH grid) or it sold — one for one (phTookOver),
//     checked right after each PH save (onPhSaved) and every 15 min (checkReleased). So a
//     pair is never unlisted in between.
// "Arrived" = received in any batch except Existing Stock (old stock counted in, not an arrival).
// Runs ONLY where PRESELL_WATCH=on — the one environment allowed to act on the shared accounts.
import {
  presellTransitMatches, claimPresellArrival, batchKindAndCode, getPresellStock, insertPresellArrival,
  presellRowsForPh, presellRowsWithReleased,
} from './db.js';
import { PLATFORM_LABEL, reconcileStock } from './presell.js';
import { sendPresellSale } from './telegram.js';
import { arrivalSplit, pairsOwed } from '../../src/lib/presellDetails.js';

export const arrivalsEnabled = (env = process.env) => String(env.PRESELL_WATCH || '').trim().toLowerCase() === 'on';

const norm = (sku, size) => `${String(sku || '').toUpperCase()}|${String(size || '').replace(/[^0-9.]/g, '')}`;
const pairs = (n) => `${n} pair${n === 1 ? '' : 's'}`;

// n pairs of one in-transit row arrived: count them, post one message. Returns what happened.
export async function countArrival(stock, n, batchCode, { notify = sendPresellSale } = {}) {
  let row = stock; let claimed = null; let split = null;
  for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
    split = arrivalSplit(row, n);
    if (!split.n) return null;   // every pair of this shipment had already arrived
    claimed = await claimPresellArrival(row.id, batchCode, { prevArrived: Number(row.arrived_qty || 0), n: split.n, release: split.release });
    if (!claimed) { row = await getPresellStock(row.id); if (!row?.in_transit || row.arrived_at) return null; }
  }
  if (!claimed) return null;
  await insertPresellArrival({ stock_id: claimed.id, batch_code: batchCode, pairs: split.n, set_aside: split.aside, released: split.release });
  const qty = Number(claimed.qty); const arrived = Number(claimed.arrived_qty); const sold = Number(claimed.sold);
  const RULE = '━━━━━━━━━━━━━━━━';
  const lines = [
    { b: split.full ? '📦 ALL ARRIVED — in-transit pre-sell' : `📦 ${pairs(split.n).toUpperCase()} ARRIVED — in-transit pre-sell` },
    '',
    { b: claimed.name || claimed.sku },
    `${claimed.sku} · size ${claimed.size}${batchCode ? ` · received in ${batchCode}` : ''}`,
    ...(claimed.supplier ? [{ b: 'Supplier:', t: ` ${claimed.supplier}` }] : []),
    ...(claimed.po_code ? [{ b: 'PO:', t: ` ${claimed.po_code}` }] : []),
    { b: 'Arrived so far:', t: ` ${arrived} of ${qty}${split.full ? '' : ` · still on the way: ${qty - arrived}`}` },
    RULE,
    { b: split.aside ? '⚠️ WAREHOUSE' : '📦 WAREHOUSE' },
    split.aside
      ? `Set ${pairs(split.aside)} aside for buyers who bought in transit — don't inbound ${split.aside === 1 ? 'it' : 'them'}. Inbound and list ${split.release}.`
      : `Nothing owed to buyers from these — inbound and list all ${split.n}.`,
    ...(pairsOwed(claimed) ? [`Still owed to buyers from the next arrivals: ${pairs(pairsOwed(claimed))} (sold in transit: ${sold}).`] : []),
    RULE,
    { b: 'Listings:', t: ` the pre-sell listings stay up — each one comes down when PH / Nikki lists one of these ${split.release} pair${split.release === 1 ? '' : 's'} on that platform.` },
  ];
  let notified = true;
  try { await notify(lines); } catch (e) { notified = false; console.error('[presell-arrival] message failed:', e.message); }
  return { stockId: claimed.id, ...split, arrived, notified };
}

// Called by insertItems after every receive commit (fire-and-forget).
export async function onItemsReceived(batchId, items, opts = {}) {
  if (!(opts.enabled ?? arrivalsEnabled())) return [];
  const counts = new Map();
  for (const it of items || []) if (it?.sku && it?.size) counts.set(norm(it.sku, it.size), (counts.get(norm(it.sku, it.size)) || 0) + 1);
  if (!counts.size) return [];
  const matches = await presellTransitMatches([...counts.keys()].map((k) => { const [sku, size] = k.split('|'); return { sku, size }; }));
  if (!matches.length) return [];
  const batch = batchId ? await batchKindAndCode(batchId) : null;
  if (batch?.kind === 'existing') return [];
  const done = [];
  for (const m of matches) {
    const r = await countArrival(m, counts.get(norm(m.sku, m.size)) || 0, batch?.batch_code, opts);
    if (r) done.push(r);
  }
  return done;
}

// PH listed (or sold) released pairs → take the same number of pre-sell listings down on that
// platform. After a PH save for these SKU + sizes, and every 15 min for every such row.
async function release(ids, opts) {
  const out = [];
  for (const id of ids) {
    const removed = await reconcileStock(id, 'ph-listed', 'ph_listed');
    if (removed.length) out.push({ stockId: id, removed });
  }
  if (out.length && opts.notify !== false) {
    const lines = [{ b: '🔄 PH LISTED ARRIVED PAIRS — pre-sell listings taken down' }];
    for (const r of out) {
      const st = await getPresellStock(r.stockId);
      const ok = (p) => r.removed.filter((x) => x.ok && x.platform === p).length;
      lines.push(`${st?.sku} · size ${st?.size}: ${['alias', 'stockx'].filter(ok).map((p) => `${PLATFORM_LABEL[p]} ${ok(p)}`).join(', ') || 'none'}`);
      const bad = r.removed.filter((x) => !x.ok);
      if (bad.length) lines.push(`   ⚠️ couldn't take down ${bad.length}: ${bad.map((x) => `${PLATFORM_LABEL[x.platform]}: ${x.error}`).join('; ')}`);
    }
    try { await (opts.send || sendPresellSale)(lines); } catch (e) { console.error('[presell-arrival] release message failed:', e.message); }
  }
  return out;
}
export async function onPhSaved(pairsList, opts = {}) {
  if (!(opts.enabled ?? arrivalsEnabled())) return [];
  const ids = (await presellRowsForPh(pairsList)).map((r) => Number(r.id));
  return ids.length ? release(ids, opts) : [];
}
export async function checkReleased(opts = {}) {
  if (!(opts.enabled ?? arrivalsEnabled())) return [];
  return release(await presellRowsWithReleased(), opts);
}
