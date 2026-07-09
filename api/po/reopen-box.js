// POST /api/po/reopen-box  (supplier / admin)  { poBoxId }
// Reopens a closed-but-not-shipped label to keep editing: 'packed' → 'pending'.
// Returns the refreshed full PO.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoBox, getPo, reopenPoBox, getPoFull, dbConfigured } from '../_lib/db.js';

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
    if (box.status !== 'packed')
      return send(res, 409, { ok: false, error: 'Only a closed (not yet shipped) label can be reopened.' });

    await reopenPoBox(poBoxId);
    const data = await getPoFull(box.po_id);
    return send(res, 200, { ok: true, ...data });
  } catch (e) {
    console.error('[po/reopen-box]', e.message);
    return send(res, 500, { ok: false, error: 'Could not reopen the label.' });
  }
}
