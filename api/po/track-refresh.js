// POST /api/po/track-refresh  (warehouse / ph_team / admin / supplier)  { poId, poBoxId? }
// Pulls current shipment status from the tracking aggregator and writes it onto the
// PO's labels. Without `poBoxId` it refreshes EVERY label on the PO (one lookup per
// tracking number); pass `poBoxId` to refresh just that ONE label — same result,
// fewer tracking-API calls/credits. A manual fallback to the webhook push. No-ops if
// tracking isn't configured (TRACKING_API_KEY unset).
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPo, getPoBox, listPoTrackingNumbers, setPoBoxTracking, getPoFull, dbConfigured } from '../_lib/db.js';
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
  // Optional: refresh a single label only (fewer tracking-API calls).
  const poBoxId = body.poBoxId != null ? Number(body.poBoxId) : null;
  if (body.poBoxId != null && !Number.isInteger(poBoxId)) return send(res, 400, { ok: false, error: 'A valid poBoxId is required.' });
  if (!trackingConfigured())
    return send(res, 400, { ok: false, error: 'Shipment tracking is not set up (no TRACKING_API_KEY).' });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });

    let numbers;
    if (poBoxId != null) {
      // Single-label refresh — validate the box belongs to this PO (BIGINT ids come
      // back as strings, so coerce before comparing).
      const box = await getPoBox(poBoxId);
      if (!box || Number(box.po_id) !== poId) return send(res, 404, { ok: false, error: 'Label not found on this order.' });
      if (!box.tracking_number) return send(res, 400, { ok: false, error: 'This label has no tracking number yet.' });
      numbers = [box.tracking_number];
    } else {
      numbers = await listPoTrackingNumbers(poId);
    }
    // fetchTrackInfo caps at 40 numbers/call — chunk so a large multi-label PO's "refresh
    // all" doesn't silently drop the tail.
    const updates = [];
    for (let i = 0; i < numbers.length; i += 40) {
      updates.push(...await fetchTrackInfo(numbers.slice(i, i + 40)));
    }
    for (const u of updates) await setPoBoxTracking(u.trackingNumber, u);
    const data = await getPoFull(poId);
    return send(res, 200, { ok: true, updated: updates.length, ...data });
  } catch (e) {
    console.error('[po/track-refresh]', e.message);
    return send(res, 502, { ok: false, error: 'Could not reach the tracking service.' });
  }
}
