// POST /api/po/create  (ph_team / admin)
//   { supplierName, supplierUserId?, tagCode?, dateOfPurchase?, notes?, orderKind?,
//     labels: [{ trackingNumber }] }
// `orderKind` is 'shoes' (default) or 'boxes' — an order of EMPTY shoe boxes, bought to
// replace the crushed and missing ones. Same paperwork, different manifest.
// Creates the PO shell (the "batch" form the PH team fills) plus one label
// (po_box) per entry, each with its pre-assigned courier tracking number. The
// supplier later fills the contents by scanning. See docs/context/purchase-orders.md.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { createPo, dbConfigured } from '../_lib/db.js';
import { registerTracking } from '../_lib/tracking.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Both directions. A SUPPLIER may raise their own order — the manifest now comes
  // before the labels, so they pack, declare, and then ask for labels.
  const user = requireRole(req, res, ['ph_team', 'supplier']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  // A supplier can only ever raise an order for THEMSELVES. Taking the account off the
  // token rather than the body is what makes that true — a posted supplierUserId would
  // otherwise let one supplier open an order against another.
  const bySupplier = user.role === 'supplier' && !isPrivileged(user.role);
  const supplierName = bySupplier
    ? String(user.name || user.username || '').trim().slice(0, 120)
    : String(body.supplierName ?? '').trim().slice(0, 120);
  const supplierUserId = bySupplier
    ? (Number.isInteger(Number(user.uid)) ? Number(user.uid) : null)
    : (Number.isInteger(Number(body.supplierUserId)) && Number(body.supplierUserId) > 0
      ? Number(body.supplierUserId) : null);
  const tagCode = String(body.tagCode ?? '').trim().slice(0, 120) || null;
  const rawDate = String(body.dateOfPurchase ?? '').trim();
  const dateOfPurchase = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  const notes = String(body.notes ?? '').trim().slice(0, 2000) || null;
  const orderKind = String(body.orderKind ?? 'shoes') === 'boxes' ? 'boxes' : 'shoes';
  const labels = (Array.isArray(body.labels) ? body.labels : [])
    .slice(0, 100)
    .map((l) => ({
      trackingNumber: String(l?.trackingNumber ?? '').trim().slice(0, 120),
      carrierKey: Number.isInteger(Number(l?.carrierKey)) && Number(l?.carrierKey) > 0 ? Number(l.carrierKey) : null,
    }));
  // Manifest-first: the supplier declares BOXES, and the tracking numbers are assigned
  // onto them later. So an order can legitimately start with boxes that carry no number
  // at all — `boxes` is how many of those to open it with.
  const rawBoxes = Number(body.boxes);
  const boxCount = Number.isInteger(rawBoxes) && rawBoxes > 0 ? Math.min(rawBoxes, 100) : 0;

  if (!supplierName) return send(res, 400, { ok: false, error: bySupplier ? 'Your account has no business name — ask us to set one.' : 'Supplier name is required.' });
  if (!labels.length && boxCount < 1)
    return send(res, 400, { ok: false, error: 'Say how many boxes this shipment has, or add at least one shipping label.' });

  try {
    const created = await createPo({
      // Numberless boxes when the manifest comes first; real labels when it doesn't.
      supplierName, supplierUserId, tagCode, dateOfPurchase, notes, orderKind,
      labels: labels.length ? labels : Array.from({ length: boxCount }, () => ({ trackingNumber: '', carrierKey: null })),
      raisedBy: bySupplier ? 'supplier' : 'ph',
      createdBy: user.name || user.username || '',
    });
    // Register each label's tracking number with 17TRACK now — not only when a supplier
    // ships via the portal (which non-compliant suppliers never do). This is what makes
    // 17TRACK start watching the box and PUSH status updates on its own. Best-effort;
    // no-ops without TRACKING_API_KEY. (docs/context/purchase-orders.md — webhook.)
    const trackItems = (created.boxes || [])
      .filter((b) => b.tracking_number)
      .map((b) => ({ number: b.tracking_number, carrier: b.carrier_key }));
    if (trackItems.length)
      registerTracking(trackItems).catch((e) => console.warn('[po/create] registerTracking:', e.message));
    return send(res, 200, { ok: true, ...created });
  } catch (e) {
    console.error('[po/create]', e.message);
    return send(res, 500, { ok: false, error: 'Could not create the purchase order.' });
  }
}
