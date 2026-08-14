// GET /api/po/get?id=  — full PO (header + labels + expected lines).
// A supplier is restricted to their own POs; staff/admin see any.
import { send, applySecurity, requireRole, isPrivileged } from '../_lib/util.js';
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
    if (user.role === 'supplier' && !isPrivileged(user.role)) {
      data.lines = (data.lines || []).map(({ entered_by, entered_by_name, entered_by_username, ...rest }) => rest);
      // Which of our batches the order was received into is internal bookkeeping — the
      // supplier has no use for a batch code and it's not theirs to see.
      delete data.batches;
      // Same rule for the reconciliation note: the supplier reads the note itself (it's
      // written for them) but not which staff member typed it — their portal renders it
      // as "From <business>". Keep the timestamp; that's not an identity.
      // Same for the labels file's storage key: they download it through the endpoint,
      // which checks it's their order — the key itself is ours.
      const { reconcile_note_by, labels_key, ...po } = data.po;
      data.po = po;
    }
    return send(res, 200, { ok: true, businessName, shipTo, ...data });
  } catch (e) {
    console.error('[po/get]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the purchase order.' });
  }
}
