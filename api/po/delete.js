// POST /api/po/delete  (ph_team / admin)  { poId, confirm }
// Deletes an order raised by mistake, or a duplicate. `confirm` must be the PO's own code
// typed back — deletion takes the labels, the manifest lines, the resolution and the
// comment thread with it (all ON DELETE CASCADE) and there is no undo.
//
// Refused while a receiving batch is linked: the record of what actually arrived must
// never disappear with the order. Unlink it first (POST /api/po/unlink-batch).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { deletePo, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin are allowed through by requireRole
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
