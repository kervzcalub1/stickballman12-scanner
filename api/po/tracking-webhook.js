// POST /api/po/tracking-webhook?secret=…   (called by 17TRACK, not our UI)
// Receives shipment-status pushes and writes them onto the matching po_box by
// tracking number. Gated by a shared secret (TRACKING_WEBHOOK_SECRET) via ?secret=
// or an X-Webhook-Secret header — there's no session here. Always answers 200 on a
// valid secret (17TRACK treats non-200 as failure and retries).
import { getJsonBody, send, applySecurity } from '../_lib/util.js';
import { setPoBoxTracking, dbConfigured } from '../_lib/db.js';
import { trackingWebhookSecret, parseWebhook, forwardTrackingToSheet } from '../_lib/tracking.js';

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
    for (const u of updates) await setPoBoxTracking(u.trackingNumber, u);
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
