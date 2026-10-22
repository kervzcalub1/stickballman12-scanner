// POST /api/po/unlink-batch  (warehouse / ph_team / admin)  { poId, batchId }
// Removes the join only — the batch and every unit in it are untouched. Used to undo a
// wrong link, and to clear the way to delete an order.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { unlinkBatchFromPo, storeOutcomeForIntake, dbConfigured } from '../_lib/db.js';
import { alertPoDiscrepancy } from '../_lib/alerts.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const batchId = Number(body.batchId);
  if (!Number.isInteger(poId) || !Number.isInteger(batchId)) {
    return send(res, 400, { ok: false, error: 'A valid poId and batchId are required.' });
  }

  try {
    const r = await unlinkBatchFromPo({
      poId,
      batchId,
      // Number(uid) || null like the other PO endpoints — see link-batch.js.
      actor: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
    });
    if (r.error) return send(res, 409, { ok: false, error: r.error });
    // A store order's per-store shortfall becomes news once it has landed (plan §4.7).
    // storeOutcomeForIntake, NOT reconcileOutcomeForIntake: that one auto-reconciles a
    // clean ordinary order as a side effect, which froze an order the moment it was linked.
    storeOutcomeForIntake(poId)
      .then((rc) => { if (rc?.byStore) alertPoDiscrepancy(rc, user); })
      .catch((e) => console.warn('[po/unlink-batch] store alert:', e.message));
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[po/unlink-batch]', e.message);
    return send(res, 500, { ok: false, error: 'Could not unlink the batch.' });
  }
}
