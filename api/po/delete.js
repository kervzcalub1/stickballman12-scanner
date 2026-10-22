// POST /api/po/delete  (supplier / ph_team / admin)  { poId, confirm }
// Deletes an order raised by mistake, or a duplicate. `confirm` must be the PO's own code
// typed back — deletion takes the labels, the manifest lines, the resolution and the
// comment thread with it (all ON DELETE CASCADE) and there is no undo.
//
// Refused while a receiving batch is linked: the record of what actually arrived must
// never disappear with the order. Unlink it first (POST /api/po/unlink-batch).
//
// A SUPPLIER may delete an order only while it is still wholly theirs: one they raised
// themselves on the portal (an order WE raised is our purchase — they ask us), still a
// draft, no label requested from us, and no box with a tracking number or gone. Past
// that point we have bought labels or a carrier has the parcel, and the order is a record
// both sides rely on.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { isSupplierRaised } from '../../src/lib/postatus.js';
import { deletePo, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team', 'supplier']);   // admin/superadmin are allowed through by requireRole
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const confirm = String(body.confirm ?? '').trim();
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });

  try {
    const { getPoFull } = await import('../_lib/db.js');
    const data = await getPoFull(poId);
    if (!data) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (user.role === 'supplier' && !isPrivileged(user.role)) {
      const { po, boxes = [] } = data;
      if (Number(po.supplier_user_id) !== Number(user.uid))
        return send(res, 404, { ok: false, error: 'Purchase order not found.' });
      if (!isSupplierRaised(po))
        return send(res, 403, { ok: false, error: `${po.po_code} was raised by our team — message us and we'll delete it.` });
      if (po.status !== 'draft' || boxes.some((b) => b.tracking_number || !['pending', 'packed'].includes(b.status)))
        return send(res, 409, { ok: false, error: `${po.po_code} already has shipping labels on it — message us and we'll delete it.` });
      if (po.labels_requested_at)
        return send(res, 409, { ok: false, error: 'You’ve asked us for labels on this order — cancel the label request first, then delete it.' });
      if (po.list_confirmed_at)
        return send(res, 409, { ok: false, error: 'You confirmed this order’s store list — message us and we’ll delete it.' });
    }
    // Checked server-side too: the typed code is the confirmation, not a UI formality.
    if (confirm.toUpperCase() !== String(data.po.po_code).toUpperCase()) {
      return send(res, 400, { ok: false, error: `Type ${data.po.po_code} exactly to confirm the deletion.` });
    }
    const r = await deletePo(poId);
    if (r.error) return send(res, 409, { ok: false, error: r.error });
    console.log(`[po/delete] ${data.po.po_code} deleted by ${user.username || user.uid} (${user.role})`);
    return send(res, 200, { ok: true, poCode: data.po.po_code });
  } catch (e) {
    console.error('[po/delete]', e.message);
    return send(res, 500, { ok: false, error: 'Could not delete the purchase order.' });
  }
}
