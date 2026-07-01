// GET /api/locations?warehouse=&area=&active=&q= -> { ok, locations }
// Browse/search shelf locations for the Locations page. Warehouse + admin.
import { send, applySecurity, rateLimit, requireRole } from './_lib/util.js';
import { listLocations, dbConfigured } from './_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 240 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const u = new URL(req.url, 'http://x');
  const activeParam = u.searchParams.get('active');
  try {
    const locations = await listLocations({
      warehouse: u.searchParams.get('warehouse') || null,
      area: u.searchParams.get('area') || null,
      active: activeParam == null || activeParam === '' ? null : activeParam === 'true',
      q: u.searchParams.get('q') || null,
    });
    return send(res, 200, { ok: true, locations });
  } catch (e) {
    console.error('[locations]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load locations.' });
  }
}
