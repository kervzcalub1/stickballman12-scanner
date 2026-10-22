// GET /api/po/get?id=  — full PO (header + labels + expected lines).
// A supplier is restricted to their own POs; staff/admin see any.
import { send, applySecurity, requireRole, isPrivileged } from '../_lib/util.js';
import { supplierPoView } from '../_lib/po-supplier-view.js';
import { getPoFull, getBusinessName, getShipTo, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team', 'warehouse', 'supplier']);
  if (!user) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'A valid id is required.' });

  try {
    const data = await getPoFull(id);
    if (!data) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (user.role === 'supplier' && !isPrivileged(user.role)
        && Number(data.po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    const businessName = await getBusinessName();
    // Where the supplier sends the box. Served here so the manifest PDF and the supplier
    // portal both get it from the fetch they already make.
    const shipTo = await getShipTo();
    // The supplier must never see WHICH staff member entered a line on their behalf —
    // only that it was entered by the business's staff. Strip the identity but keep the
    // on-behalf flag so their portal can show the generic "<business>'s Staff" note.
    // Which staff member entered a line, our received counts and batches, the reconciliation
    // note's author, the labels file key, and a store order's audit side all stay ours —
    // one strip-list for every supplier-facing endpoint (po-supplier-view.js).
    const out = user.role === 'supplier' && !isPrivileged(user.role) ? supplierPoView(data) : data;
    return send(res, 200, { ok: true, businessName, shipTo, ...out });
  } catch (e) {
    console.error('[po/get]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the purchase order.' });
  }
}
