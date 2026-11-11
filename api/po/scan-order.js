// POST /api/po/scan-order  (supplier / ph_team / admin)
//   { poId, sku, size, dimensions?, qty?, name?, upc?, colorway?, gender?, unitCost?, tip? }
// Whole-order manifest (Path C): the supplier gave ONE list for the whole purchase with no
// per-box breakdown, so it's entered against the PO itself (a po_line with po_box_id NULL)
// rather than a specific label. Flips the PO to manifest_scope='po'.
// A PO can't mix a per-box manifest and a whole-order one. Writes only po_lines.
//
// Two callers:
//   · staff (PH / admin) on the supplier's behalf — any order, `draft` or `receiving`,
//     shoes or empty boxes; always `entered_on_behalf`.
//   · the SUPPLIER scanning their own whole-order list (2026-11-12, "📷 Scan the whole-order
//     manifest") — exactly the gate their whole-order paste has in po/scan-bulk
//     (`supplierOrderListBlock`: own order, draft, never 'order+box', shoes only), plus
//     what applies to everyone below; their own line (`entered_on_behalf=false`).
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPo, poHasBoxLines, addPoOrderScan, setPoManifestScope, dbConfigured } from '../_lib/db.js';
import { money, isBoxesOrder, normalizeDimensions, supplierOrderListBlock } from '../_lib/po-manifest.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  const supplier = user.role === 'supplier' && !isPrivileged(user.role);
  // A supplier's scanner posts ONE pair per scan (staff's window posts one line per size of a
  // finished shoe), so a gun through 300 pairs needs more room than 120/min. The client also
  // folds repeat scans of one size that queue up behind a write into a single post.
  if (!rateLimit(req, { windowMs: 60_000, max: supplier ? 300 : 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const sku = String(body.sku ?? '').trim().slice(0, 60);
  const size = String(body.size ?? '').trim().slice(0, 20);
  const qty = Math.min(999, Math.max(1, parseInt(body.qty, 10) || 1));
  const dimensions = normalizeDimensions(body.dimensions);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid order is required.' });
  if (!sku) return send(res, 400, { ok: false, error: 'A SKU is required.' });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (supplier) {
      const blocked = supplierOrderListBlock({ po, user });
      if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error });
    }
    // An empty-box line is keyed on the size AND the carton's dimensions; a shoe line on
    // the size alone.
    const boxesOrder = isBoxesOrder(po);
    if (!size)
      return send(res, 400, { ok: false, error: boxesOrder ? 'Say which shoe size this box is for.' : 'SKU and size are required.' });
    if (boxesOrder && !dimensions)
      return send(res, 400, { ok: false, error: 'This order is for empty shoe boxes — give the box\u2019s length, width and height.' });
    // A shoes order has no carton to describe. Refuse rather than silently drop it: a
    // caller sending dimensions here has a bug, and quietly ignoring the field is how
    // "I entered it and it vanished" happens.
    if (!boxesOrder && body.dimensions !== undefined && body.dimensions !== null && body.dimensions !== '')
      return send(res, 400, { ok: false, error: 'This order is for shoes — a pair has a size, not box dimensions.' });
    // Editable while the order is still coming AND while it's being received. The whole
    // premise of a whole-order manifest is a supplier who doesn't use the portal, so their
    // list routinely turns up after the boxes do — locking it at `draft` meant a list that
    // arrived an hour late could never be entered, and the order reconciled "received
    // blind" with every pair reading as an overage. These lines only feed `expected`; the
    // warehouse's own count is recorded independently, so a late manifest can't rewrite
    // what was received.
    if (po.by_store)
      return send(res, 409, { ok: false, error: 'This order is split by store — add to the store list instead.' });
    if (po.status !== 'draft' && po.status !== 'receiving')
      return send(res, 409, { ok: false, error: 'This order is already closed — it can no longer be edited.' });
    if (await poHasBoxLines(poId))
      return send(res, 409, { ok: false, error: 'This PO already has a per-box manifest — add items to a label instead.' });

    // Env admin/superadmin have a non-numeric uid; stamp the flag but leave entered_by NULL.
    // The supplier's own line carries neither (as their paste in po/scan-bulk).
    const uidNum = Number(user.uid);
    const enteredBy = !supplier && Number.isInteger(uidNum) ? uidNum : null;

    const line = await addPoOrderScan({
      poId, sku, size,
      dimensions: boxesOrder ? dimensions : null,
      qty,
      name: String(body.name ?? '').trim().slice(0, 200) || null,
      upc: String(body.upc ?? '').trim().slice(0, 40) || null,
      colorway: String(body.colorway ?? '').trim().slice(0, 120) || null,
      gender: String(body.gender ?? '').trim().slice(0, 20) || null,
      unitCost: money(body.unitCost),
      tip: money(body.tip),
      enteredBy,
      enteredOnBehalf: !supplier,
    });
    await setPoManifestScope(poId, 'po');
    return send(res, 200, { ok: true, line });
  } catch (e) {
    console.error('[po/scan-order]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the item.' });
  }
}
