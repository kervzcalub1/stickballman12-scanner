// POST /api/po/close  (warehouse / ph_team / admin)  { poId }
// Archives a reconciled PO → status 'closed' (it drops off the active
// reconciliation list). Only allowed from 'reconciled'.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { closePo, dbConfigured } from '../_lib/db.js';

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
    const po = await closePo(poId);
    if (!po) return send(res, 409, { ok: false, error: 'Only a reconciled purchase order can be archived.' });
    return send(res, 200, { ok: true, po });
  } catch (e) {
    console.error('[po/close]', e.message);
    return send(res, 500, { ok: false, error: 'Could not archive the purchase order.' });
  }
}
