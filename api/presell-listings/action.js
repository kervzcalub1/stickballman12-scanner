// POST /api/presell-listings/action
//   Listing: { listingId, action: 'activate'|'deactivate'|'update'|'delete'|'refresh', price?, size? }
//   Stock:   { stockId,   action: 'qty', qty }                                → set how many pairs we have
//            { stockId,   action: 'list', platform, price, activate }         → list up to the pairs left
//   Details: { stockIds:[…], action: 'details', … }  → cost / supplier / PO / tracking / in transit
//            (only the keys sent change; see detailsAction)
//   Boxes (docs/presell-box-tracking-plan.md):
//            { action: 'boxContents', poId, boxId, sku, lines: [{ size, qty|null }] } → what one box holds of a SKU
//            { action: 'boxUnknown', stockIds, boxIds }   → split unknown: these sizes are somewhere in these boxes
//            { action: 'makePo', stockIds, supplierName, trackingNumbers } → a PO (our labels) for rows on no PO
// Pre-sell Listings (docs/context/presell-listings.md). The row changes only after the
// platform said yes; a StockX change is PENDING until the watcher confirms it.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import {
  dbConfigured, getPresellListing, getPresellStock, setPresellStockQty, upsertPresellStock, updatePresellListing, movePresellListing,
  updatePresellStockDetails, getPoBrief, setPresellCompBase, setPresellLock, presellPoCap, bumpPresellStockPo, movePresellStockPo,
  getPoBoxBrief, setPresellBoxLines, addPresellBoxUnknown, presellPoBoxGrid, createPo, linkPresellToNewPo, poCodesByTracking,
} from '../_lib/db.js';
import { registerTracking } from '../_lib/tracking.js';
import { boxSummary } from '../../src/lib/presellBoxes.js';
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
    if (b.action === 'boxContents') return await boxContentsAction(res, b, actor);
    if (b.action === 'boxUnknown') return await boxUnknownAction(res, b, actor);
    if (b.action === 'makePo') return await makePoAction(res, b, user, actor);
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
    // Re-pointed to another order: its pairs' count against the order moves with it.
    if (Object.prototype.hasOwnProperty.call(common, 'po_id') && Number(stock.po_id || 0) !== Number(common.po_id || 0)) {
      await movePresellStockPo(id, stock.po_id ? Number(stock.po_id) : null, common.po_id, Number(stock.qty));
    }
    rows.push(await updatePresellStockDetails(id, patch, actor));
  }
  if (!rows.length) return send(res, 404, { ok: false, error: 'Those stock rows no longer exist.' });
  return send(res, 200, { ok: true, rows });
}

// 📦 Box contents (docs/presell-box-tracking-plan.md): what one of the order's labels holds
// of one SKU, size by size — for a box the supplier never declared (a whole-order manifest).
// A box with the supplier's own list is read-only here: their list wins. A size can't end
// up with more pairs in boxes than the row has.
const boxIdsOf = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number))].filter((n) => Number.isSafeInteger(n) && n > 0);
async function editableBox(res, boxId, poId) {
  const box = await getPoBoxBrief(boxId);
  if (!box || (poId && Number(box.po_id) !== Number(poId))) { send(res, 404, { ok: false, error: 'That box is not on this order any more.' }); return null; }
  if (box.kind === 'replacement') { send(res, 409, { ok: false, error: 'That’s a reship box — its contents come from the reship manifest.' }); return null; }
  if (box.declared) { send(res, 409, { ok: false, error: `The supplier already declared what’s in ${box.tracking_number || 'this box'} — their list is used.` }); return null; }
  if (box.po_status === 'closed') { send(res, 409, { ok: false, error: `${box.po_code} is archived.` }); return null; }
  return box;
}
async function boxContentsAction(res, b, actor) {
  const boxId = Number(b.boxId); const poId = Number(b.poId);
  const sku = String(b.sku || '').trim().slice(0, 80);
  if (!(boxId > 0) || !(poId > 0) || !sku) return send(res, 400, { ok: false, error: 'Which box and shoe?' });
  const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 60).map((l) => ({
    size: String(l?.size ?? '').trim().slice(0, 20),
    qty: l?.qty === null ? null : Math.max(0, Math.min(999, parseInt(l?.qty, 10) || 0)),
  })).filter((l) => l.size);
  if (!(await editableBox(res, boxId, poId))) return;
  // Would any size end up with more pairs in boxes than the row has?
  const grid = await presellPoBoxGrid(poId, sku);
  const bad = [];
  for (const z of grid.sizes) {
    const l = lines.find((x) => x.size === z.size);
    const others = z.boxes.filter((x) => x.id !== boxId);
    const next = [...others, ...(l && (l.qty === null || l.qty > 0) ? [{ qty: l.qty }] : [])];
    const sum = boxSummary(z.qty, next);
    if (sum.over > 0) bad.push(`size ${z.size}: ${sum.placed} in boxes but only ${z.qty} pair${z.qty === 1 ? '' : 's'}`);
  }
  const known = new Set(grid.sizes.map((z) => z.size));
  const stray = lines.filter((l) => !known.has(l.size) && (l.qty === null || l.qty > 0));
  if (stray.length) return send(res, 400, { ok: false, error: `Size ${stray.map((l) => l.size).join(", ")} of ${sku} isn’t pre-listed against ${grid.po.po_code}.` });
  if (bad.length) return send(res, 409, { ok: false, code: 'over_boxes', error: `Too many in boxes — ${bad.join('; ')}.` });
  await setPresellBoxLines(boxId, sku, lines, actor);
  return send(res, 200, { ok: true, ...(await presellPoBoxGrid(poId, sku)) });
}
async function boxUnknownAction(res, b, actor) {
  const ids = boxIdsOf(b.stockIds).slice(0, 200); const boxIds = boxIdsOf(b.boxIds).slice(0, 100);
  if (!ids.length || !boxIds.length) return send(res, 400, { ok: false, error: 'Tick the sizes and the boxes.' });
  const rows = (await Promise.all(ids.map((id) => getPresellStock(id)))).filter(Boolean);
  if (!rows.length) return send(res, 404, { ok: false, error: 'Those stock rows no longer exist.' });
  let poId = null;
  for (const id of boxIds) {
    const box = await editableBox(res, id, null);
    if (!box) return;
    poId = poId ?? Number(box.po_id);
    if (Number(box.po_id) !== poId) return send(res, 400, { ok: false, error: 'Pick boxes from one order at a time.' });
  }
  // Every row has to be on that order — a box only holds pairs bought on it.
  const off = rows.filter((r) => Number(r.po_id) !== poId);
  if (off.length) return send(res, 409, { ok: false, error: `Link ${off.map((r) => `size ${r.size}`).join(', ')} to the order first (✎ Cost & shipment → Purchase order).` });
  const added = await addPresellBoxUnknown(boxIds, rows, actor);
  return send(res, 200, { ok: true, added });
}

// "Make a PO for this buy" (plan phase 4): we hand out every tracking number, so a buy we
// track IS an order of our labels. Opens the PO with one label per tracking number (registered
// with 17TRACK like po/create) and NO lines — the supplier still scans what's in each box, or
// PH fills the 📦 Box contents grid. Only rows on no PO yet; PH / admin only (as po/create).
async function makePoAction(res, b, user, actor) {
  if (!isPrivileged(user.role) && user.role !== 'ph_team') return send(res, 403, { ok: false, error: 'Only PH or an admin can open a purchase order.' });
  const ids = boxIdsOf(b.stockIds).slice(0, 200);
  const supplierName = String(b.supplierName ?? '').trim().slice(0, 120);
  const tracks = parseTrackingList(b.trackingNumbers);
  if (!ids.length) return send(res, 400, { ok: false, error: 'Which sizes?' });
  if (!supplierName) return send(res, 400, { ok: false, error: 'Who is the supplier?' });
  if (!tracks.length) return send(res, 400, { ok: false, error: 'Add the tracking numbers we gave the supplier — one label per box.' });
  const rows = (await Promise.all(ids.map((id) => getPresellStock(id)))).filter(Boolean);
  const onPo = rows.filter((r) => r.po_id);
  if (onPo.length) return send(res, 409, { ok: false, error: `Already on an order: ${onPo.map((r) => `size ${r.size} (${r.po_code})`).join(', ')}.` });
  // A tracking number already on an order means that order exists — link to it instead.
  const taken = await poCodesByTracking(tracks);
  if (taken.length) return send(res, 409, { ok: false, error: `${taken[0].tracking_number} is already on ${taken[0].po_code} — pick that order under ✎ Cost & shipment instead.` });
  const created = await createPo({
    supplierName, labels: tracks.map((t) => ({ trackingNumber: t, carrierKey: null })),
    notes: `Opened from Pre-sell Listings for ${[...new Set(rows.map((r) => r.sku))].join(', ')}.`, createdBy: actor || '',
  });
  const trackItems = (created.boxes || []).filter((x) => x.tracking_number).map((x) => ({ number: x.tracking_number, carrier: x.carrier_key }));
  if (trackItems.length) registerTracking(trackItems).catch((e) => console.warn('[presell makePo] registerTracking:', e.message));
  const poId = Number(created.po.id);
  const linked = await linkPresellToNewPo(rows.map((r) => Number(r.id)), poId, actor);
  return send(res, 200, { ok: true, poId, poCode: created.po.po_code, linked, labels: trackItems.length });
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
    // More pairs on a row listed against a PO: the same cap as listing (create.js). The
    // change is booked against the row's CURRENT PO; lowering is always allowed.
    const delta = qty - Number(stock.qty);
    if (delta > 0 && stock.po_id) {
      const cap = await presellPoCap(Number(stock.po_id), stock.sku, stock.size);
      if (cap.hasList && cap.listed + delta > cap.expected) {
        return send(res, 409, { ok: false, code: 'over_po', error:
          `${stock.po_code} lists ${cap.expected} of ${stock.sku} size ${stock.size} — ${cap.listed} already pre-listed, you're adding ${delta}.` });
      }
    }
    await setPresellStockQty(id, qty, actor);
    if (stock.po_id && delta) await bumpPresellStockPo(id, Number(stock.po_id), delta);
    // Fewer pairs than open listings → the extras come down now.
    const removed = await reconcileStock(id, actor, 'qty_cut');
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
    // A price set by hand is the new "price we set" for market competition: the $5 floor
    // is measured from it from now on.
    // It is also what the 🔒 lock holds the size at from now on.
    if (out.ok && priceCents != null && !newSize) {
      await setPresellCompBase(l.stock_id, l.platform, priceCents);
      await setPresellLock(l.stock_id, l.platform, priceCents);
    }
    // A size change means this pair is really the other size: it moves to that stock row.
    if (out.ok && newSize) {
      const old = await getPresellStock(l.stock_id);
      const moved = await upsertPresellStock({ sku: old.sku, size: newSize, name: old.name, image: old.image, upc: null, addQty: 1 }, actor);
      if (Number(old.qty) - 1 >= Number(old.sold)) await setPresellStockQty(old.id, Number(old.qty) - 1, actor);
      // The pair it really is moves its PO count with it.
      if (old.po_id) { await bumpPresellStockPo(old.id, Number(old.po_id), -1); await bumpPresellStockPo(Number(moved.id), Number(old.po_id), 1); }
      await movePresellListing(l.id, moved.id, actor);
    }
  } else return send(res, 400, { ok: false, error: 'Unknown action.' });

  if (!out.ok) {
    await updatePresellListing(l.id, { last_error: out.error }, actor);
    return send(res, out.notFound ? 404 : 502, { ok: false, error: out.notFound ? `${l.platform === 'alias' ? 'Alias' : 'StockX'} has no listing with this id any more.` : out.error });
  }
  if (b.action === 'delete') extra.delete_reason = 'user';
  await applyResult(l, out, actor, extra);
  return send(res, 200, { ok: true, listing: await getPresellListing(l.id) });
}

