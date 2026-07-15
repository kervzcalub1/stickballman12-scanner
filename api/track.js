// GET|POST /api/track?number=1Z999...[&carrier=100002]  ->  { ok, trackingNumber, status }
//
// PUBLIC, NO-AUTH tracking lookup. Given a tracking number (and optional 17TRACK
// numeric carrier key) it returns ONLY the latest shipment status from 17TRACK.
// Reads `number`/`carrier` from the query string (easy to curl) or a JSON body.
//
// 17TRACK only returns data for numbers it's already tracking, so we register the
// number first (idempotent — re-registering an existing number is harmless) then
// pull its current status.
import { getJsonBody, send, applySecurity, rateLimit } from './_lib/util.js';
import { trackingConfigured, registerTracking, fetchTrackInfo } from './_lib/tracking.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  if (!trackingConfigured()) return send(res, 500, { ok: false, error: 'Shipment tracking is not set up (no TRACKING_API_KEY).' });

  // Params come from the query string or, for POST, the JSON body.
  const url = new URL(req.url, 'http://localhost');
  const body = req.method === 'POST' ? await getJsonBody(req) : {};
  const number = String(url.searchParams.get('number') ?? body.number ?? '').trim();
  const carrierRaw = url.searchParams.get('carrier') ?? body.carrier ?? null;
  const carrier = Number.isInteger(Number(carrierRaw)) && Number(carrierRaw) > 0 ? Number(carrierRaw) : null;
  if (!number) return send(res, 400, { ok: false, error: 'Missing `number` (tracking number).' });

  const item = carrier ? { number, carrier } : { number };

  try {
    // Register first so 17TRACK begins tracking (no-op if already registered), then pull.
    await registerTracking([item]);
    const [info] = await fetchTrackInfo([item]);
    if (!info) return send(res, 404, { ok: false, trackingNumber: number, status: null, error: 'No tracking info found for that number yet.' });
    return send(res, 200, { ok: true, trackingNumber: info.trackingNumber, status: info.trackingStatus });
  } catch (e) {
    console.error('[track]', e.message);
    return send(res, 502, { ok: false, error: 'Could not reach the tracking service.' });
  }
}
