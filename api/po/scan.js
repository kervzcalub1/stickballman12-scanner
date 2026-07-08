// POST /api/po/scan  (supplier / admin)
//   { poBoxId, sku, size, qty?, name?, upc?, colorway?, gender?, unitCost? }
// Adds/increments an expected line under one label of a DRAFT PO the supplier
// owns. Product details are resolved client-side (reusing the existing UPC/SKU
// search) and posted here; this only writes po_lines — never the receiving path.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoBox, getPo, addPoScan, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poBoxId = Number(body.poBoxId);
  const sku = String(body.sku ?? '').trim().slice(0, 60);
  const size = String(body.size ?? '').trim().slice(0, 20);
  const qty = Math.min(999, Math.max(1, parseInt(body.qty, 10) || 1));
  if (!Number.isInteger(poBoxId)) return send(res, 400, { ok: false, error: 'A valid label is required.' });
  if (!sku || !size) return send(res, 400, { ok: false, error: 'SKU and size are required.' });

  try {
    const box = await getPoBox(poBoxId);
    if (!box) return send(res, 404, { ok: false, error: 'Label not found.' });
    const po = await getPo(box.po_id);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (!isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    if (po.status !== 'draft')
      return send(res, 409, { ok: false, error: 'This order is already shipped — it can no longer be edited.' });
    if (box.status !== 'pending')
      return send(res, 409, { ok: false, error: 'This label is already shipped.' });

    const line = await addPoScan({
      poId: box.po_id, poBoxId, sku, size, qty,
      name: String(body.name ?? '').trim().slice(0, 200) || null,
      upc: String(body.upc ?? '').trim().slice(0, 40) || null,
      colorway: String(body.colorway ?? '').trim().slice(0, 120) || null,
      gender: String(body.gender ?? '').trim().slice(0, 20) || null,
      unitCost: body.unitCost != null && body.unitCost !== '' ? Number(body.unitCost) : null,
    });
    return send(res, 200, { ok: true, line });
  } catch (e) {
    console.error('[po/scan]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the item.' });
  }
}
