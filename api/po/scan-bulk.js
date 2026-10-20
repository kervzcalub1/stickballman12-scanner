// POST /api/po/scan-bulk  (supplier / ph_team / admin)
//   { poBoxId, shoes: [{ sku, name?, colorway?, gender?, unitCost?, tip?, sizes: [{ size, qty }] }] }  → one label
//   { poId,    shoes: [...] }                                                                           → the whole order (PH, or the supplier on their own draft)
//   -> { ok, lines, pairs }
//
// "Paste a list" in the Add-items window (PoScanModal, src/lib/poPaste.js): a supplier's
// "SKU / size x qty" message, many shoes at once. Exactly what po/scan (a label) and
// po/scan-order (the whole order) do one line at a time — the same gates, the same
// attribution, the same addPoScan / addPoOrderScan (an existing SKU+size ADDS to its qty,
// so pasting a second time tops up rather than doubling a row) — but in ONE request:
// those two are rate-limited to 120/min, a real list is easily more, and a loop that 429s
// halfway leaves the label half-declared. Everything is validated before anything is written.
//
// Shoes only: an empty-box order's line needs box dimensions, which a size list doesn't carry.
// No UPC is taken — a UPC belongs to ONE size, and a SKU lookup's UPC on every size row is
// the "first scan's code stamped on every size" bug ([[upc-is-per-size]]).
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoBox, getPo, addPoScan, addPoOrderScan, poHasBoxLines, setPoManifestScope, dbConfigured } from '../_lib/db.js';
import { manifestEditBlock, isReplacementBox, money, isBoxesOrder } from '../_lib/po-manifest.js';
import { declaresPerBox, hasOrderedList } from '../../src/lib/postatus.js';

const MAX_SHOES = 150;
const MAX_LINES = 1000;
const str = (v, n) => String(v ?? '').trim().slice(0, n) || null;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const orderMode = body.poBoxId == null;
  const poBoxId = orderMode ? null : Number(body.poBoxId);
  if (!orderMode && !Number.isInteger(poBoxId)) return send(res, 400, { ok: false, error: 'A valid label is required.' });
  if (orderMode && !Number.isInteger(Number(body.poId))) return send(res, 400, { ok: false, error: 'A valid order is required.' });

  // The list, checked whole before a single line is written.
  const shoes = Array.isArray(body.shoes) ? body.shoes : [];
  if (!shoes.length) return send(res, 400, { ok: false, error: 'Nothing to add — paste at least one SKU with its sizes.' });
  if (shoes.length > MAX_SHOES) return send(res, 400, { ok: false, error: `At most ${MAX_SHOES} SKUs in one paste.` });
  const lines = [];
  for (const s of shoes) {
    const sku = str(s?.sku, 60)?.toUpperCase();
    if (!sku) return send(res, 400, { ok: false, error: 'Every shoe needs a SKU.' });
    const unitCost = money(s.unitCost);
    const tip = money(s.tip);
    const sizes = Array.isArray(s.sizes) ? s.sizes : [];
    if (!sizes.length) return send(res, 400, { ok: false, error: `${sku}: no sizes.` });
    for (const z of sizes) {
      const size = str(z?.size, 20);
      const qty = parseInt(z?.qty, 10);
      if (!size) return send(res, 400, { ok: false, error: `${sku}: a size is blank.` });
      if (!(qty >= 1 && qty <= 999)) return send(res, 400, { ok: false, error: `${sku} size ${size}: quantity must be 1–999.` });
      lines.push({ sku, size, qty, name: str(s.name, 200), colorway: str(s.colorway, 120), gender: str(s.gender, 20), unitCost, tip });
    }
  }
  if (lines.length > MAX_LINES) return send(res, 400, { ok: false, error: `At most ${MAX_LINES} sizes in one paste.` });

  try {
    let po; let box = null;
    if (orderMode) {
      po = await getPo(Number(body.poId));
      if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
      // A supplier may paste the whole-order list too: they often have ONE manifest for the
      // whole purchase before anything is split into boxes. Their own order only, only
      // while it's still a draft (once every label has shipped it's PH's to correct), and
      // never onto an order raised from a buying request — that order-level list is OUR
      // receipt ('order+box'), not the supplier's account of what they sent.
      if (user.role === 'supplier' && !isPrivileged(user.role)) {
        if (Number(po.supplier_user_id) !== Number(user.uid))
          return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
        if (hasOrderedList(po))
          return send(res, 409, { ok: false, error: 'This order lists what you send per box — add items to one of your labels.' });
        if (po.status !== 'draft')
          return send(res, 409, { ok: false, error: 'Every label on this order has shipped — the manifest can no longer be edited here.' });
      }
      if (po.status !== 'draft' && po.status !== 'receiving')
        return send(res, 409, { ok: false, error: 'This order is already closed — it can no longer be edited.' });
      if (await poHasBoxLines(po.id))
        return send(res, 409, { ok: false, error: 'This PO already has a per-box manifest — add items to a label instead.' });
    } else {
      box = await getPoBox(poBoxId);
      if (!box) return send(res, 404, { ok: false, error: 'Label not found.' });
      po = await getPo(box.po_id);
      if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
      if (user.role === 'supplier' && !isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
        return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
      if (!declaresPerBox(po) && !isReplacementBox(box))
        return send(res, 409, { ok: false, error: 'This PO uses a whole-order manifest — add items to the order, not a label.' });
    }
    if (isBoxesOrder(po))
      return send(res, 409, { ok: false, error: 'This order is for empty shoe boxes — each box needs its dimensions, so add them one at a time.' });
    const onBehalf = user.role !== 'supplier';
    const uidNum = Number(user.uid);
    const enteredBy = onBehalf && Number.isInteger(uidNum) ? uidNum : null;
    if (!orderMode) {
      const blocked = manifestEditBlock({ po, box, onBehalf });
      if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error });
    }

    const written = [];
    for (const l of lines) {
      const common = { poId: po.id, sku: l.sku, size: l.size, dimensions: null, qty: l.qty, name: l.name, upc: null,
        colorway: l.colorway, gender: l.gender, unitCost: l.unitCost, tip: l.tip };
      written.push(orderMode
        ? await addPoOrderScan({ ...common, enteredBy, enteredOnBehalf: onBehalf })
        : await addPoScan({ ...common, poBoxId, enteredBy, enteredOnBehalf: onBehalf }));
    }
    if (orderMode) await setPoManifestScope(po.id, 'po');
    return send(res, 200, { ok: true, lines: written, pairs: lines.reduce((n, l) => n + l.qty, 0) });
  } catch (e) {
    console.error('[po/scan-bulk]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the list. Anything already added shows on the label — check it before pasting again.' });
  }
}
