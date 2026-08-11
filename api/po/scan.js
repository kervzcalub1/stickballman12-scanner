// POST /api/po/scan  (supplier / ph_team / admin)
//   { poBoxId, sku, size, qty?, name?, upc?, colorway?, gender?, unitCost?, tip? }
// Adds/increments an expected line under one label of a DRAFT PO. The supplier scans
// their own manifest; PH/admin can enter it ON THEIR BEHALF when the supplier doesn't
// (stamped entered_by + entered_on_behalf). Product details are resolved client-side
// (reusing the UPC/SKU search); this only writes po_lines — never the receiving path.
//
// A REPLACEMENT label takes a different gate (`manifestEditBlock`) and skips the
// whole-order-scope check: a reship is one specific label whatever shape the original
// purchase was declared in, and its lines never reach the reconciliation `expected` count.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoBox, getPo, addPoScan, dbConfigured } from '../_lib/db.js';
import { manifestEditBlock, isReplacementBox, money } from '../_lib/po-manifest.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poBoxId = Number(body.poBoxId);
  const sku = String(body.sku ?? '').trim().slice(0, 60);
  const size = String(body.size ?? '').trim().slice(0, 20);
  const qty = Math.min(999, Math.max(1, parseInt(body.qty, 10) || 1));
  if (!Number.isInteger(poBoxId)) return send(res, 400, { ok: false, error: 'A valid label is required.' });
  if (!sku || !size) return send(res, 400, { ok: false, error: 'SKU and size are required.' });

  try {
    const box = await getPoBox(poBoxId);
    if (!box) return send(res, 404, { ok: false, error: 'Label not found.' });
    const po = await getPo(box.po_id);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    // A supplier is scoped to their own POs; PH/admin can fill any PO on the team's behalf.
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    // A PO is one manifest scope or the other — no mixing a whole-order manifest with
    // per-box lines. A reship is exempt: it's its own label regardless of how the original
    // purchase was declared, and it can't pollute the whole-order roll-up.
    if (po.manifest_scope === 'po' && !isReplacementBox(box))
      return send(res, 409, { ok: false, error: 'This PO uses a whole-order manifest — add items to the order, not a label.' });
    // Anyone but the supplier scanning their own order is entering it on the supplier's behalf.
    // entered_by references users(id); the env admin/superadmin have a non-numeric uid, so
    // stamp the flag but leave entered_by NULL for them (no real users row to point at).
    const onBehalf = user.role !== 'supplier';
    const uidNum = Number(user.uid);
    const enteredBy = onBehalf && Number.isInteger(uidNum) ? uidNum : null;
    const blocked = manifestEditBlock({ po, box });
    if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error });

    const line = await addPoScan({
      poId: box.po_id, poBoxId, sku, size, qty,
      name: String(body.name ?? '').trim().slice(0, 200) || null,
      upc: String(body.upc ?? '').trim().slice(0, 40) || null,
      colorway: String(body.colorway ?? '').trim().slice(0, 120) || null,
      gender: String(body.gender ?? '').trim().slice(0, 20) || null,
      unitCost: money(body.unitCost),
      tip: money(body.tip),
      enteredBy,
      enteredOnBehalf: onBehalf,
    });
    return send(res, 200, { ok: true, line });
  } catch (e) {
    console.error('[po/scan]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the item.' });
  }
}
