// POST /api/shein/connect -> { ok, url }   SHEIN's authorization page for the seller account
// POST /api/shein/connect { disconnect: true } -> { ok }
// Admin only (links the company SHEIN account). docs/context/shein-fix.md → "SHEIN API".
import { send, applySecurity, rateLimit, requireAdmin, getJsonBody } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { sheinConfigured, sheinMissing, sheinConsentUrl, sheinDisconnect } from '../_lib/shein.js';
import { secretsConfigured } from '../_lib/secrets.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAdmin(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 10 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const by = user.name || user.username || '';
  const body = await getJsonBody(req);
  if (body.disconnect) { await sheinDisconnect(by); return send(res, 200, { ok: true }); }
  if (!sheinConfigured()) return send(res, 503, { ok: false, error: `SHEIN API isn't set up yet — waiting for SHEIN to approve our app (missing ${sheinMissing().join(', ')}).` });
  if (!secretsConfigured()) return send(res, 503, { ok: false, error: 'BUY_GC_KEY is not set — the SHEIN keys have to be stored encrypted.' });
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return send(res, 200, { ok: true, url: await sheinConsentUrl(by, `${proto}://${host}/api/shein/callback`) });
}
