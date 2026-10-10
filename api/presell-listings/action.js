// POST /api/presell-listings/action
//   Listing: { listingId, action: 'activate'|'deactivate'|'update'|'delete'|'refresh', price?, size? }
//   Stock:   { stockId,   action: 'qty', qty }                                → set how many pairs we have
//            { stockId,   action: 'list', platform, price, activate }         → list up to the pairs left
//   Details: { stockIds:[…], action: 'details', … }  → cost / supplier / PO / tracking / in transit
//            (only the keys sent change; see detailsAction)
// Pre-sell Listings (docs/context/presell-listings.md). The row changes only after the
// platform said yes; a StockX change is PENDING until the watcher confirms it.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  dbConfigured, getPresellListing, getPresellStock, setPresellStockQty, upsertPresellStock, updatePresellListing, movePresellListing,
  updatePresellStockDetails, getPoBrief,
} from '../_lib/db.js';
import { landedFromShelf } from '../../src/lib/costs.js';
import { cleanCostStack, cleanShelf, parseTrackingList } from '../../src/lib/presellDetails.js';
import { PLATFORMS, applyResult, reconcileStock } from '../_lib/presell.js';
import { topUp } from '../_lib/presell-create.js';

const sizeNumber = (s) => { const m = String(s || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const actor = user.name || user.username || null;
  try {
    if (b.action === 'details') return await detailsAction(res, b, actor);
    if (b.stockId != null) return await stockAction(res, b, actor);
    return await listingAction(res, b, actor);
  } catch (e) {
    console.error('[presell-listings/action]', e.message);
    // A timeout is NOT "nothing changed": the marketplace may have done it after we gave up.
    const timedOut = e?.name === 'AbortError' || e?.name === 'TimeoutError' || /abort/i.test(e?.message || '');
    return send(res, 504, { ok: false, error: timedOut
      ? 'The marketplace didn’t answer in time — it may still have gone through. Press ↻ on the listing to see where it stands.'
      : 'Could not reach the marketplace — nothing was changed here.' });
  }
}

// ✎ Cost & shipment (2026-10-10): fix up stock rows after listing — a cost that was never
// entered (no preset picked, a shelf price forgotten), the supplier, the PO it was bought
// on, every tracking number, the in-transit details. One call for the rows of a SKU:
//   { stockIds, cost?: { costStack|null, shelf: { [stockId]: price|null } },
//     supplier?, poId?, trackingNumbers?, inTransit?, transitNote?, expectedOn? }
// The landed cost is recomputed HERE from shelf + stack (landedFromShelf); a shelf price
// without a preset saves the shelf and leaves the cost blank (owner's rule).
async function detailsAction(res, b, actor) {
  const ids = [...new Set((Array.isArray(b.stockIds) ? b.stockIds : []).map(Number))].filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length || ids.length > 200) return send(res, 400, { ok: false, error: 'Which stock rows?' });
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const common = {};
  if (has('supplier')) common.supplier = String(b.supplier ?? '').trim().slice(0, 80) || null;
  if (has('poId')) {
    const poId = Number(b.poId) > 0 ? Number(b.poId) : null;
    if (poId && !(await getPoBrief(poId))) return send(res, 400, { ok: false, error: 'That purchase order no longer exists.' });
    common.po_id = poId;
  }
  if (has('trackingNumbers')) common.tracking_numbers = parseTrackingList(b.trackingNumbers);
  if (has('inTransit')) common.in_transit = b.inTransit === true;
  if (has('transitNote')) common.transit_note = String(b.transitNote ?? '').trim().slice(0, 200) || null;
  if (has('expectedOn')) common.expected_on = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expectedOn || '')) ? b.expectedOn : null;
  const cost = b.cost && typeof b.cost === 'object' ? b.cost : null;
  const stack = cost ? cleanCostStack(cost.costStack) : null;
  const shelfFor = cost?.shelf && typeof cost.shelf === 'object' ? cost.shelf : {};
  if (!Object.keys(common).length && !cost) return send(res, 400, { ok: false, error: 'Nothing to change.' });
  const rows = [];
  for (const id of ids) {
    const stock = await getPresellStock(id);
    if (!stock) continue;
    const patch = { ...common };
    if (cost) {
      // A row missing from `shelf` keeps its shelf price; the stack applies to every row.
      const shelf = Object.prototype.hasOwnProperty.call(shelfFor, String(id)) ? cleanShelf(shelfFor[id]) : (stock.shelf_price != null ? Number(stock.shelf_price) : null);
      patch.shelf_price = shelf;
      patch.cost_stack = stack;
      patch.unit_cost = shelf != null && stack ? landedFromShelf(shelf, null, stack) : null;
    }
    rows.push(await updatePresellStockDetails(id, patch, actor));
  }
  if (!rows.length) return send(res, 404, { ok: false, error: 'Those stock rows no longer exist.' });
  return send(res, 200, { ok: true, rows });
}

async function stockAction(res, b, actor) {
  const id = Number(b.stockId);
  if (!Number.isSafeInteger(id) || id <= 0) return send(res, 400, { ok: false, error: 'Which stock row?' });
  const stock = await getPresellStock(id);
  if (!stock) return send(res, 404, { ok: false, error: 'That stock row no longer exists.' });
  if (b.action === 'qty') {
    const qty = Number(b.qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > 999) return send(res, 400, { ok: false, error: 'The quantity has to be a whole number from 0 to 999.' });
    if (qty < Number(stock.sold)) return send(res, 400, { ok: false, error: `${stock.sold} already sold — the quantity can't go below that.` });
    await setPresellStockQty(id, qty, actor);
    // Fewer pairs than open listings → the extras come down now.
    const removed = await reconcileStock(id, actor);
    return send(res, 200, { ok: true, stock: await getPresellStock(id), removed });
  }
  if (b.action === 'list') {
    if (!['alias', 'stockx'].includes(b.platform)) return send(res, 400, { ok: false, error: 'Which platform?' });
    const p = Number(b.price);
    if (!Number.isFinite(p) || p < 1 || p > 100_000) return send(res, 400, { ok: false, error: 'The price has to be from $1 to $100,000.' });
    const out = await topUp(stock, b.platform, { priceCents: Math.round(p) * 100, active: b.activate === true }, actor);
    if (!out.wanted) return send(res, 409, { ok: false, error: `Nothing to list — every pair left is already on ${b.platform === 'alias' ? 'Alias' : 'StockX'}.` });
    return send(res, 200, { ok: true, ...out });
  }
  return send(res, 400, { ok: false, error: 'Unknown action.' });
}

async function listingAction(res, b, actor) {
  const id = Number(b.listingId);
  if (!Number.isSafeInteger(id) || id <= 0) return send(res, 400, { ok: false, error: 'Which listing?' });
  const l = await getPresellListing(id);
  if (!l) return send(res, 404, { ok: false, error: 'That listing no longer exists.' });
  if (['sold', 'deleted'].includes(l.status) && b.action !== 'refresh') return send(res, 409, { ok: false, error: `That listing is already ${l.status}.` });
  if (l.status === 'pending' && b.action !== 'refresh') return send(res, 409, { ok: false, error: 'StockX is still working on the last change to this listing — give it a few seconds.' });
  if (!l.external_id) return send(res, 409, { ok: false, error: 'This listing never reached the marketplace.' });
  const P = PLATFORMS[l.platform];
  let out; const extra = {};
  if (b.action === 'activate') {
    // Going live is where overselling would start — only while a pair is still left.
    const stock = await getPresellStock(l.stock_id);
    if (Number(stock.sold) >= Number(stock.qty)) return send(res, 409, { ok: false, error: 'Every pair of this size is sold — nothing left to put live.' });
    out = await P.activate(l);
  } else if (b.action === 'deactivate') out = await P.deactivate(l);
  else if (b.action === 'delete') out = await P.remove(l);
  else if (b.action === 'refresh') out = await P.refresh(l);
  else if (b.action === 'update') {
    let priceCents = null; let newSize = null;
    if (b.price != null && b.price !== '') {
      const p = Number(b.price);
      if (!Number.isFinite(p) || p < 1 || p > 100_000) return send(res, 400, { ok: false, error: 'The price has to be from $1 to $100,000.' });
      priceCents = Math.round(p) * 100;
    }
    if (b.size != null && String(b.size).trim() && String(b.size).trim() !== l.size) {
      if (l.platform !== 'alias') return send(res, 400, { ok: false, error: 'StockX can’t change a listing’s size — delete it and list the right size.' });
      newSize = String(b.size).trim().slice(0, 20);
      if (!Number.isFinite(sizeNumber(newSize))) return send(res, 400, { ok: false, error: `"${newSize}" isn't a size Alias can list.` });
    }
    if (priceCents == null && newSize == null) return send(res, 400, { ok: false, error: 'Nothing to change.' });
    out = await P.update(l, { priceCents: priceCents ?? Number(l.price_cents), sizeValue: newSize ? sizeNumber(newSize) : null });
    if (out.ok && priceCents != null && out.price_cents === undefined && l.platform === 'alias') extra.price_cents = priceCents;
    // A size change means this pair is really the other size: it moves to that stock row.
    if (out.ok && newSize) {
      const old = await getPresellStock(l.stock_id);
      const moved = await upsertPresellStock({ sku: old.sku, size: newSize, name: old.name, image: old.image, upc: null, addQty: 1 }, actor);
      if (Number(old.qty) - 1 >= Number(old.sold)) await setPresellStockQty(old.id, Number(old.qty) - 1, actor);
      await movePresellListing(l.id, moved.id, actor);
    }
  } else return send(res, 400, { ok: false, error: 'Unknown action.' });

  if (!out.ok) {
    await updatePresellListing(l.id, { last_error: out.error }, actor);
    return send(res, out.notFound ? 404 : 502, { ok: false, error: out.notFound ? `${l.platform === 'alias' ? 'Alias' : 'StockX'} has no listing with this id any more.` : out.error });
  }
  await applyResult(l, out, actor, extra);
  return send(res, 200, { ok: true, listing: await getPresellListing(l.id) });
}

