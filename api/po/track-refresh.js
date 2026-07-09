// POST /api/po/track-refresh  (warehouse / ph_team / admin)  { poId }
// Pulls current shipment status for a PO's labels from the tracking aggregator and
// writes it onto each po_box. A manual fallback to the webhook push (and the only
// path usable before a public webhook URL exists). No-ops if tracking isn't
// configured (TRACKING_API_KEY unset).
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPo, listPoTrackingNumbers, setPoBoxTracking, getPoFull, dbConfigured } from '../_lib/db.js';
import { trackingConfigured, fetchTrackInfo } from '../_lib/tracking.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Supplier is included because the "Refresh tracking" button lives in their portal
  // (scoped to their own PO below); warehouse/ph_team see all.
  const user = requireRole(req, res, ['warehouse', 'ph_team', 'supplier']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });
  if (!trackingConfigured())
    return send(res, 400, { ok: false, error: 'Shipment tracking is not set up (no TRACKING_API_KEY).' });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    const numbers = await listPoTrackingNumbers(poId);
    const updates = await fetchTrackInfo(numbers);
    for (const u of updates) await setPoBoxTracking(u.trackingNumber, u);
    const data = await getPoFull(poId);
    return send(res, 200, { ok: true, updated: updates.length, ...data });
  } catch (e) {
    console.error('[po/track-refresh]', e.message);
    return send(res, 502, { ok: false, error: 'Could not reach the tracking service.' });
  }
}
