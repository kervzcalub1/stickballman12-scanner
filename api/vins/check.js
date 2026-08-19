// GET /api/vins/check?vin=SBM-R-000123  ->  { ok, state, item }
// Is this pre-printed sticker free? Called as each 1ID is scanned at intake.
// `state`: available | assigned | void | unknown.
//
// Intake treats a FAILED call as "carry on" rather than "stop" — see vin-stock.md.
// Blocking here would let flaky warehouse Wi-Fi halt intake, which is the exact
// failure this whole feature exists to remove. `items.vin` is UNIQUE NOT NULL, so a
// double-assign is impossible regardless of what this endpoint managed to say.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { checkVinStock, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  // One call per scan, and scanning is the fast path — this ceiling is deliberately high.
  if (!rateLimit(req, { windowMs: 60_000, max: 600 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const vin = new URL(req.url, 'http://x').searchParams.get('vin') || '';
  try {
    const r = await checkVinStock(vin);
    return send(res, 200, { ok: true, ...r });
  } catch (e) {
    console.error('[vins/check]', e.message);
    return send(res, 500, { ok: false, error: 'Could not check that sticker.' });
  }
}
