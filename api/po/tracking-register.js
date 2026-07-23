// POST /api/po/tracking-register?secret=…   (called by the Google Apps Script, not our UI)
// The Apps Script sends label tracking numbers from the sheet; we register them with 17TRACK
// so it starts monitoring them and will WEBHOOK status updates back to us. This is the
// "sheet → server → 17TRACK" half of the loop; the "17TRACK → server → sheet" half is the
// webhook (api/po/tracking-webhook.js). Gated by the shared secret (TRACKING_WEBHOOK_SECRET)
// via ?secret= or an X-Webhook-Secret header — there's no session here.
//
// The Apps Script decides WHICH numbers and WHEN to send (e.g. only labels put into service),
// so registration stays deliberate and quota-friendly. This endpoint just registers whatever
// it's given and reports back what 17TRACK accepted vs rejected.
import { getJsonBody, send, applySecurity } from '../_lib/util.js';
import { trackingWebhookSecret, trackingConfigured, registerTracking } from '../_lib/tracking.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });

  const secret = trackingWebhookSecret();
  const provided = new URL(req.url, 'http://x').searchParams.get('secret') || req.headers['x-webhook-secret'] || '';
  if (!secret || provided !== secret) return send(res, 401, { ok: false, error: 'Unauthorized.' });
  if (!trackingConfigured()) return send(res, 400, { ok: false, error: 'Shipment tracking is not set up (no TRACKING_API_KEY).' });

  try {
    const body = await getJsonBody(req);
    // Accept { trackingNumbers: [...] } (plain strings), { items: [{ number, carrier }] },
    // or a single { trackingNumber }. carrier is optional (17TRACK auto-detects otherwise).
    let raw = [];
    if (Array.isArray(body?.trackingNumbers)) raw = body.trackingNumbers;
    else if (Array.isArray(body?.items)) raw = body.items;
    else if (body?.trackingNumber != null) raw = [body.trackingNumber];

    // Normalize + de-dupe. registerTracking accepts a bare string or { number, carrier }.
    const seen = new Set();
    const list = [];
    for (const it of raw) {
      const num = String((it && typeof it === 'object' ? it.number : it) || '').trim();
      if (!num) continue;
      const key = num.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const carrier = it && typeof it === 'object' ? it.carrier : undefined;
      list.push(carrier != null ? { number: num, carrier } : num);
    }
    if (!list.length) return send(res, 400, { ok: false, error: 'Provide trackingNumbers[] (or trackingNumber).' });

    // 17TRACK caps /register at 40 per call — chunk so a large batch never drops the tail.
    let accepted = 0, rejected = 0;
    const rejectedDetail = [];
    for (let i = 0; i < list.length; i += 40) {
      const resp = await registerTracking(list.slice(i, i + 40));
      accepted += (resp?.data?.accepted || []).length;
      for (const r of (resp?.data?.rejected || [])) {
        rejected++;
        if (rejectedDetail.length < 100)
          rejectedDetail.push({ number: r.number || null, error: r?.error?.message || r?.error?.code || 'rejected' });
      }
    }
    // "already registered" comes back as a rejection but isn't a real failure — the number is
    // still being tracked. We surface the raw counts so the caller can tell the difference.
    return send(res, 200, { ok: true, received: list.length, accepted, rejected, rejectedDetail });
  } catch (e) {
    console.error('[po/tracking-register]', e.message);
    return send(res, 500, { ok: false, error: 'Registration failed.' });
  }
}
