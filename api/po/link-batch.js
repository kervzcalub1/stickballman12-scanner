// POST /api/po/link-batch  (warehouse / ph_team / admin)
//   { poId, batchId, boxMap?: [{ boxId|null, poBoxId }], shipLabels?: bool }
// Attaches an ALREADY-RECEIVED batch to its purchase order. "Receive against a purchase
// order" is a step-1 choice, so an order opened while the warehouse was already scanning
// could never be joined to that shipment — it read as outstanding forever while its stock
// sat on the shelf. See docs/context/purchase-orders.md.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { linkBatchToPo, dbConfigured } from '../_lib/db.js';

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
  const boxMap = (Array.isArray(body.boxMap) ? body.boxMap : [])
    .slice(0, 200)
    .filter((m) => Number.isInteger(Number(m?.poBoxId)))
    .map((m) => ({
      boxId: Number.isInteger(Number(m.boxId)) && Number(m.boxId) > 0 ? Number(m.boxId) : null,
      poBoxId: Number(m.poBoxId),
    }));

  try {
    const r = await linkBatchToPo({
      poId, batchId, boxMap, shipLabels: body.shipLabels === true,
      // Number(uid) || null like the other PO endpoints: the env admin/superadmin
      // accounts have a non-numeric uid, and author_id is a BIGINT — passing it straight
      // through makes the insert throw and the audit note vanish.
      actor: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
    });
    // 409: a real conflict about the order's state (already reconciled, batch taken) —
    // the client shows it and reloads rather than treating it as a broken request.
    if (r.error) return send(res, 409, { ok: false, error: r.error });
    return send(res, 200, { ok: true, po: r.po });
  } catch (e) {
    console.error('[po/link-batch]', e.message);
    return send(res, 500, { ok: false, error: 'Could not link the batch to this purchase order.' });
  }
}
