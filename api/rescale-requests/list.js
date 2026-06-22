// GET /api/rescale-requests/list?status=open -> { ok, requests }
// Warehouse inbox of PH rescale requests (open by default). Readable by staff.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listRescaleRequests, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const p = new URL(req.url, 'http://x').searchParams;
  const sp = p.get('status');
  const status = sp === 'all' ? null : (sp === 'audited' ? 'audited' : 'open');
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const from = isDate(p.get('from')) ? p.get('from') : null;
  const to = isDate(p.get('to')) ? p.get('to') : null;

  try {
    const requests = await listRescaleRequests(status, from, to);
    return send(res, 200, { ok: true, requests });
  } catch (e) {
    console.error('[rescale-requests/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load requests.' });
  }
}
