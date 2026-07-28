// POST /api/po/tracking-webhook?secret=…   (called by 17TRACK, not our UI)
// Receives shipment-status pushes and writes them onto the matching po_box by
// tracking number. Gated by a shared secret (TRACKING_WEBHOOK_SECRET) via ?secret=
// or an X-Webhook-Secret header — there's no session here.
//
// Ack-first: once the body is read we answer 200 IMMEDIATELY, then do the DB work AFTER
// responding. 17TRACK treats any non-200 — including a gateway 504 from a slow or OOM dyno —
// as failure and retries; acking first keeps a momentary slowdown from dropping the push.
// The work below is idempotent and also reachable via the manual Refresh, so finishing it
// after the response loses nothing. (We run on a persistent Express process, so async work
// continues after the response is flushed.)
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

  let body;
  try {
    body = await getJsonBody(req);
  } catch (e) {
    return send(res, 400, { ok: false, error: 'Invalid JSON body.' });
  }

  // Acknowledge 17TRACK right now, before touching the DB (see header note). The response is
  // flushed here, so the sender sees 200 regardless of how long the processing below takes.
  send(res, 200, { ok: true });

  // Everything past this point runs after the response and is idempotent + best-effort.
  try {
    const updates = parseWebhook(body);
    // Diagnostic: one concise line per push so 17TRACK payload parsing can be verified from the
    // Railway logs (e.g. after firing the dashboard's "Test Webhook"). Shows exactly what we
    // extracted — number : raw-status → mapped-stage — so a payload-shape change is obvious.
    console.log('[po/tracking-webhook] parsed', updates.length,
      updates.map((u) => `${u.trackingNumber}:${u.trackingStatus || '?'}`
        + `${u.subStatus ? `/${u.subStatus}` : ''}→${u.boxStatus || 'null'}`).join(', ') || '(none)');
    // If a push parsed to zero, log the envelope shape (not the full body) to diagnose a
    // 17TRACK version/format change without dumping sensitive tracking data.
    if (!updates.length)
      console.warn('[po/tracking-webhook] 0 parsed — body keys:', Object.keys(body || {}),
        '· data:', Array.isArray(body?.data) ? `array[${body.data.length}]` : typeof body?.data);

    const affectedPoIds = new Set();
    for (const u of updates) {
      const rows = await setPoBoxTracking(u.trackingNumber, u);
      for (const r of (rows || [])) if (r?.po_id != null) affectedPoIds.add(Number(r.po_id));
    }
    // Roll each touched PO off "Filling" once all its labels have left the supplier.
    for (const poId of affectedPoIds) await rollupPoShippedFromTracking(poId);
    // Stop tracking anything that's now delivered — a delivered parcel won't change again, so
    // keeping it on auto-tracking just burns 17TRACK quota. Covers every delivered number in
    // the push (matched or not), since the whole account funnels through here. Best-effort.
    const deliveredNums = updates.filter((u) => u.boxStatus === 'delivered').map((u) => u.trackingNumber);
    if (deliveredNums.length)
      stopTracking(deliveredNums).catch((e) => console.warn('[po/tracking-webhook] stoptrack:', e.message));
    // Mirror the update into the warehouse's Google Sheet (best-effort, env-gated).
    forwardTrackingToSheet(updates).catch((e) => console.warn('[po/tracking-webhook] sheet:', e.message));
  } catch (e) {
    // We've already returned 200; a failure here is logged, not surfaced. The next push or a
    // manual Refresh will re-apply the same (idempotent) update.
    console.error('[po/tracking-webhook] async:', e.message);
  }
}
