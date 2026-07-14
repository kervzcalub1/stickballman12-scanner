// POST /api/po/create  (ph_team / admin)
//   { supplierName, supplierUserId?, tagCode?, dateOfPurchase?, notes?,
//     labels: [{ trackingNumber }] }
// Creates the PO shell (the "batch" form the PH team fills) plus one label
// (po_box) per entry, each with its pre-assigned courier tracking number. The
// supplier later fills the contents by scanning. See docs/context/purchase-orders.md.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { createPo, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const supplierName = String(body.supplierName ?? '').trim().slice(0, 120);
  const supplierUserId = Number.isInteger(Number(body.supplierUserId)) && Number(body.supplierUserId) > 0
    ? Number(body.supplierUserId) : null;
  const tagCode = String(body.tagCode ?? '').trim().slice(0, 120) || null;
  const rawDate = String(body.dateOfPurchase ?? '').trim();
  const dateOfPurchase = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  const notes = String(body.notes ?? '').trim().slice(0, 2000) || null;
  const labels = (Array.isArray(body.labels) ? body.labels : [])
    .slice(0, 100)
    .map((l) => ({
      trackingNumber: String(l?.trackingNumber ?? '').trim().slice(0, 120),
      carrierKey: Number.isInteger(Number(l?.carrierKey)) && Number(l?.carrierKey) > 0 ? Number(l.carrierKey) : null,
    }));

  if (!supplierName) return send(res, 400, { ok: false, error: 'Supplier name is required.' });
  if (labels.length < 1) return send(res, 400, { ok: false, error: 'Add at least one shipping label.' });

  try {
    const po = await createPo({
      supplierName, supplierUserId, tagCode, dateOfPurchase, notes, labels,
      createdBy: user.name || user.username || '',
    });
    return send(res, 200, { ok: true, ...po });
  } catch (e) {
    console.error('[po/create]', e.message);
    return send(res, 500, { ok: false, error: 'Could not create the purchase order.' });
  }
}
