// POST /api/po/line  (supplier / admin)  { lineId, qty?, size? }
// Edits an expected line's quantity and/or size; qty <= 0 removes the line. Only on
// a DRAFT PO the supplier owns, and only while its label is still pending. Changing
// the size into an existing SKU+size line on the same label merges the two.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoLine, getPoBox, getPo, updatePoLine, dbConfigured } from '../_lib/db.js';

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
  if (!Number.isInteger(lineId)) return send(res, 400, { ok: false, error: 'A valid line is required.' });
  const hasQty = body.qty !== undefined;
  const hasSize = body.size !== undefined;
  if (!hasQty && !hasSize) return send(res, 400, { ok: false, error: 'Nothing to update.' });
  const qty = hasQty ? Math.min(999, Math.max(0, parseInt(body.qty, 10) || 0)) : undefined;
  const size = hasSize ? String(body.size ?? '').trim().slice(0, 20) : undefined;
  if (hasSize && !size) return send(res, 400, { ok: false, error: 'Size can’t be blank.' });

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
    if (box && box.status === 'packed')
      return send(res, 409, { ok: false, error: 'This label is closed — reopen it to edit.' });
    if (box && box.status !== 'pending')
      return send(res, 409, { ok: false, error: 'This label is already shipped.' });

    const { line: updated, removed, merged } = await updatePoLine(lineId, { size, qty });
    return send(res, 200, { ok: true, line: updated, removed, merged });
  } catch (e) {
    console.error('[po/line]', e.message);
    // A concurrent edit converging on the same (po_box_id, sku, size) can trip the unique
    // index between the merge check and the write — surface as a conflict, not a 500.
    if (e.code === '23505') return send(res, 409, { ok: false, error: 'That size was just changed — reopen the label and try again.' });
    return send(res, 500, { ok: false, error: 'Could not update the item.' });
  }
}
