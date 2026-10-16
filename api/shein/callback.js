// GET /api/shein/callback?tempToken=…&state=…   SHEIN sends the owner's browser here after
// they approve. No app login on this request, so the one-time `state` is the proof. Always
// ends back on the SHEIN page with the outcome. docs/context/shein-fix.md → "SHEIN API".
import { applySecurity, rateLimit } from '../_lib/util.js';
import { sheinFinishConnect } from '../_lib/shein.js';
import webhook from './webhook.js';

const back = (res, q) => { res.statusCode = 302; res.setHeader('Location', `/ph/shein-check?${q}`); res.end(); };

export default async function handler(req, res) {
  // SHEIN's webhooks POST to the app's one callback URL — this one (docs/context/shein-live-fix.md).
  if (req.method === 'POST') return webhook(req, res);
  applySecurity(req, res);
  if (!rateLimit(req, { windowMs: 60_000, max: 10 })) return back(res, 'shein_error=' + encodeURIComponent('Too many attempts — wait a minute.'));
  const qs = new URL(req.url, 'http://x').searchParams;
  try {
    await sheinFinishConnect({ tempToken: qs.get('tempToken') || qs.get('temp_token') || qs.get('token'), state: qs.get('state') });
    return back(res, 'shein=connected');
  } catch (e) {
    console.error('[shein/callback]', e.message);
    return back(res, 'shein_error=' + encodeURIComponent(e.message));
  }
}
