// POST /api/po/line  (supplier / admin)  { lineId, qty }
// Adjusts an expected line's quantity; qty <= 0 removes the line. Only on a
// DRAFT PO the supplier owns, and only while its label is still pending.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoLine, getPoBox, getPo, setPoLineQty, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const lineId = Number(body.lineId);
  const qty = Math.min(999, Math.max(0, parseInt(body.qty, 10) || 0));
  if (!Number.isInteger(lineId)) return send(res, 400, { ok: false, error: 'A valid line is required.' });

  try {
    const line = await getPoLine(lineId);
    if (!line) return send(res, 404, { ok: false, error: 'Line not found.' });
    const box = await getPoBox(line.po_box_id);
    const po = await getPo(line.po_id);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (!isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    if (po.status !== 'draft')
      return send(res, 409, { ok: false, error: 'This order is already shipped — it can no longer be edited.' });
    if (box && box.status !== 'pending')
      return send(res, 409, { ok: false, error: 'This label is already shipped.' });

    const updated = await setPoLineQty(lineId, qty);
    return send(res, 200, { ok: true, line: updated, removed: updated == null });
  } catch (e) {
    console.error('[po/line]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the item.' });
  }
}
