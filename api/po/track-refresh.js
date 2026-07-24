// POST /api/po/track-refresh  (warehouse / ph_team / admin / supplier)  { poId, poBoxId? }
// Pulls current shipment status from the tracking aggregator and writes it onto the
// PO's labels. Without `poBoxId` it refreshes EVERY label on the PO (one lookup per
// tracking number); pass `poBoxId` to refresh just that ONE label — same result,
// fewer tracking-API calls/credits. A manual fallback to the webhook push. No-ops if
// tracking isn't configured (TRACKING_API_KEY unset).
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPo, getPoBox, listPoTrackingItems, setPoBoxTracking, rollupPoShippedFromTracking, getPoFull, dbConfigured } from '../_lib/db.js';
import { trackingConfigured, fetchTrackInfo, forwardTrackingToSheet, registerTracking, stopTracking } from '../_lib/tracking.js';

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

    let items; // [{ number, carrier }]
    if (poBoxId != null) {
      // Single-label refresh — validate the box belongs to this PO (BIGINT ids come
      // back as strings, so coerce before comparing).
      const box = await getPoBox(poBoxId);
      if (!box || Number(box.po_id) !== poId) return send(res, 404, { ok: false, error: 'Label not found on this order.' });
      if (!box.tracking_number) return send(res, 400, { ok: false, error: 'This label has no tracking number yet.' });
      items = [{ number: box.tracking_number, carrier: box.carrier_key }];
    } else {
      items = await listPoTrackingItems(poId);
    }
    // Self-heal: (re-)register every number first (idempotent) so 17TRACK is tracking
    // it and will PUSH future updates. Registration otherwise only happens at PO-creation
    // and at ship — a number attached any other way (label import, a box the supplier
    // never formally "shipped") is never registered, so it silently stops auto-updating
    // and the box can sit on "Filling" even after the parcel is delivered. Registering on
    // refresh turns this button into a repair tool. Best-effort — a failure here must not
    // block the pull below.
    for (let i = 0; i < items.length; i += 40) {
      await registerTracking(items.slice(i, i + 40)).catch((e) => console.warn('[po/track-refresh] register:', e.message));
    }
    // fetchTrackInfo caps at 40/call — chunk so a large multi-label PO's "refresh all"
    // doesn't silently drop the tail. Each item carries its carrier key.
    const updates = [];
    for (let i = 0; i < items.length; i += 40) {
      updates.push(...await fetchTrackInfo(items.slice(i, i + 40)));
    }
    for (const u of updates) await setPoBoxTracking(u.trackingNumber, u);
    // Now that box statuses are current, roll the PO off "Filling" if every label has left
    // the supplier (delivered/in-transit/shipped) — the supplier may never have tapped "ship".
    await rollupPoShippedFromTracking(poId);
    // Stop tracking any label that's now delivered so it stops consuming 17TRACK quota
    // (matches the webhook path). Best-effort — a failure here must not fail the refresh.
    const deliveredNums = updates.filter((u) => u.boxStatus === 'delivered').map((u) => u.trackingNumber);
    if (deliveredNums.length)
      stopTracking(deliveredNums).catch((e) => console.warn('[po/track-refresh] stoptrack:', e.message));
    // Keep the warehouse's Google Sheet in sync on manual pulls too (best-effort, env-gated).
    forwardTrackingToSheet(updates).catch((e) => console.warn('[po/track-refresh] sheet:', e.message));
    const data = await getPoFull(poId);
    return send(res, 200, { ok: true, updated: updates.length, ...data });
  } catch (e) {
    console.error('[po/track-refresh]', e.message);
    return send(res, 502, { ok: false, error: 'Could not reach the tracking service.' });
  }
}
