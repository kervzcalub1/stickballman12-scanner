// POST /api/po/tracking-webhook?secret=…   (called by 17TRACK, not our UI)
// Receives shipment-status pushes and writes them onto the matching po_box by
// tracking number. Gated by a shared secret (TRACKING_WEBHOOK_SECRET) via ?secret=
// or an X-Webhook-Secret header — there's no session here. Always answers 200 on a
// valid secret (17TRACK treats non-200 as failure and retries).
import { getJsonBody, send, applySecurity } from '../_lib/util.js';
import { setPoBoxTracking, rollupPoShippedFromTracking, dbConfigured } from '../_lib/db.js';
import { trackingWebhookSecret, parseWebhook, forwardTrackingToSheet, stopTracking } from '../_lib/tracking.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });

  const secret = trackingWebhookSecret();
  const provided = new URL(req.url, 'http://x').searchParams.get('secret') || req.headers['x-webhook-secret'] || '';
  if (!secret || provided !== secret) return send(res, 401, { ok: false, error: 'Unauthorized.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const body = await getJsonBody(req);
    const updates = parseWebhook(body);
    const affectedPoIds = new Set();
    for (const u of updates) {
      const rows = await setPoBoxTracking(u.trackingNumber, u);
      for (const r of (rows || [])) if (r?.po_id != null) affectedPoIds.add(Number(r.po_id));
    }
    // Roll each touched PO off "Filling" once all its labels have left the supplier.
    for (const poId of affectedPoIds) await rollupPoShippedFromTracking(poId);
    // Stop tracking anything that's now delivered — a delivered parcel won't change again,
    // so keeping it on auto-tracking just burns 17TRACK quota. Covers every delivered number
    // in the push (matched or not), since the whole account funnels through here. Best-effort.
    const deliveredNums = updates.filter((u) => u.boxStatus === 'delivered').map((u) => u.trackingNumber);
    if (deliveredNums.length)
      stopTracking(deliveredNums).catch((e) => console.warn('[po/tracking-webhook] stoptrack:', e.message));
    // Mirror the update into the warehouse's Google Sheet (best-effort, env-gated).
    forwardTrackingToSheet(updates).catch((e) => console.warn('[po/tracking-webhook] sheet:', e.message));
    // Always 200 so the sender doesn't retry a push we accepted (even if 0 matched
    // a known label — a stray number isn't an error on our side).
    return send(res, 200, { ok: true, applied: updates.length });
  } catch (e) {
    console.error('[po/tracking-webhook]', e.message);
    return send(res, 500, { ok: false, error: 'Webhook processing failed.' });
  }
}
