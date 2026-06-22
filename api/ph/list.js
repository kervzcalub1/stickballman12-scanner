// GET /api/ph/list?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=  ->  { ok, rows }
// PH grid for an EST date range. Restricted to the ph_team and admin roles.
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
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const from = isDate(p.get('from')) ? p.get('from') : null;
  const to = isDate(p.get('to')) ? p.get('to') : null;
  const kindParam = p.get('kind');
  const kind = kindParam === 'receiving' || kindParam === 'rescale' ? kindParam : null;

  try {
    const rows = await phListItems(from, to, kind);
    return send(res, 200, { ok: true, rows });
  } catch (e) {
    console.error('[ph/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the monthly list.' });
  }
}
