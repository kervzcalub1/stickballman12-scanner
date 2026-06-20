// GET /api/ph/list?month=&year=  ->  { ok, rows }
// PH Team monthly grid: items scanned in the given EST month, sorted by scan
// date. Restricted to the ph_team and admin roles.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { phListItems, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // All staff can VIEW the report; only PH Team can edit (see ph/update).
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const p = new URL(req.url, 'http://x').searchParams;
  const month = Math.min(12, Math.max(1, Number(p.get('month')) || 0));
  const year = Number(p.get('year')) || 0;
  const kindParam = p.get('kind');
  const kind = kindParam === 'receiving' || kindParam === 'rescale' ? kindParam : null;
  if (!month || year < 2000 || year > 3000)
    return send(res, 400, { ok: false, error: 'Provide a valid month and year.' });

  try {
    const rows = await phListItems(month, year, kind);
    return send(res, 200, { ok: true, rows });
  } catch (e) {
    console.error('[ph/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the monthly list.' });
  }
}
