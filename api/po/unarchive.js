// POST /api/po/unarchive  (warehouse / ph_team / admin)  { poId }
// Brings an archived PO back → status 'reconciled'. Archiving was a one-way door:
// nothing moved a PO out of 'closed' and receiving against it is blocked, so a mis-tap
// or a late box meant editing the database by hand.
// Lands on 'reconciled', not 'receiving' — the frozen count still stands; this only
// makes the order visible and workable again.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { unarchivePo, getPo, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });

  try {
    const po = await unarchivePo(poId);
    if (!po) {
      // Say which way it actually failed — "not archived" and "doesn't exist" need
      // different reactions from whoever tapped the button.
      const found = await getPo(poId);
      if (!found) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
      return send(res, 409, { ok: false, error: `${found.po_code} is ${found.status}, not archived — nothing to bring back.` });
    }
    return send(res, 200, { ok: true, po });
  } catch (e) {
    console.error('[po/unarchive]', e.message);
    return send(res, 500, { ok: false, error: 'Could not unarchive the purchase order.' });
  }
}
