// POST /api/po/tie-box  (warehouse / ph_team / admin)  { poId, batchBoxId, poBoxId|null }
//   -> { ok, ...order }
// "Box received without its label → tie it to …" (docs/store-orders-plan.md §4.4). A
// store order's received box that matched none of its labels belongs to no store until
// a person says which label it is; this writes `batch_boxes.po_box_id` for it. `poBoxId`
// null unties it again. Every tie leaves a system comment on the order.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { tiePoReceivedBox, getPoFull, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const batchBoxId = Number(body.batchBoxId);
  const poBoxId = body.poBoxId == null || body.poBoxId === '' ? null : Number(body.poBoxId);
  if (!Number.isInteger(poId) || !Number.isInteger(batchBoxId) || (poBoxId != null && !Number.isInteger(poBoxId))) {
    return send(res, 400, { ok: false, error: 'A valid order, received box and label are required.' });
  }

  try {
    const r = await tiePoReceivedBox({
      poId, batchBoxId, poBoxId,
      actor: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
    });
    if (r.error) return send(res, 409, { ok: false, error: r.error });
    return send(res, 200, { ok: true, ...(await getPoFull(poId)) });
  } catch (e) {
    console.error('[po/tie-box]', e.message);
    return send(res, 500, { ok: false, error: 'Could not tie the box.' });
  }
}
