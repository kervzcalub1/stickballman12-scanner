// GET /api/locations/lookup?code=MNH-WH-A2-04 -> { ok, location }
// Resolve a scanned shelf barcode for the Shelve page. Warehouse + admin.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getLocationByCode, dbConfigured } from '../_lib/db.js';
import { normalizeLocationCode } from '../_lib/locations.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 240 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const code = normalizeLocationCode(new URL(req.url, 'http://x').searchParams.get('code'));
  if (!code) return send(res, 400, { ok: false, error: 'A valid shelf code is required.' });
  try {
    const location = await getLocationByCode(code);
    if (!location) return send(res, 404, { ok: false, error: `Unknown shelf “${code}”.` });
    return send(res, 200, { ok: true, location });
  } catch (e) {
    console.error('[locations/lookup]', e.message);
    return send(res, 500, { ok: false, error: 'Could not look up the shelf.' });
  }
}
