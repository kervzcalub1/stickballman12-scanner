// POST /api/po/close-box  (supplier / admin)  { poBoxId }
// Closes one label for shipment after review: 'pending' (filling) → 'packed'
// (ready to ship). Must hold ≥1 item. Editing (scan) is blocked while packed;
// the supplier can reopen it to keep editing. Returns the refreshed full PO.
import { STILL_WITH_SUPPLIER } from '../_lib/po-manifest.js';
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged, hideReceivedUnits } from '../_lib/util.js';
import { getPoBox, getPo, countPoBoxLines, closePoBox, getPoFull, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poBoxId = Number(body.poBoxId);
  if (!Number.isInteger(poBoxId)) return send(res, 400, { ok: false, error: 'A valid label is required.' });

  try {
    const box = await getPoBox(poBoxId);
    if (!box) return send(res, 404, { ok: false, error: 'Label not found.' });
    const po = await getPo(box.po_id);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (!isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    // `pre_transit` is still with the supplier — the carrier has the label on file, not
    // the parcel — so the box can still be closed for shipment. See STILL_WITH_SUPPLIER.
    if (!STILL_WITH_SUPPLIER.includes(box.status))
      return send(res, 409, { ok: false, error: 'This label is already closed.' });
    if ((await countPoBoxLines(poBoxId)) < 1)
      return send(res, 400, { ok: false, error: 'Scan at least one item into this label before closing it.' });

    await closePoBox(poBoxId);
    const data = await getPoFull(box.po_id);
    if (!isPrivileged(user.role)) data.boxes = hideReceivedUnits(data.boxes);
    return send(res, 200, { ok: true, ...data });
  } catch (e) {
    console.error('[po/close-box]', e.message);
    return send(res, 500, { ok: false, error: 'Could not close the label.' });
  }
}
