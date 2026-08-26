// GET /api/rescale-requests/list?status=open|audited|cancelled|closed|all  (comma-separated ok)
//   -> { ok, requests }  — each request carries `vins`: the pairs it was raised for.
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
  // One status, a comma-separated LIST of them, or 'all'. The PH grid's Rescale tab
  // wants open + audited together — open is "awaiting a count", audited is the work,
  // and they are one worklist. Anything unrecognised falls back to 'open' rather than
  // widening the query by accident.
  const sp = p.get('status');
  const KNOWN = ['open', 'audited', 'cancelled', 'closed'];
  const asked = String(sp || '').split(',').map((s) => s.trim()).filter((s) => KNOWN.includes(s));
  const status = sp === 'all' ? null : (asked.length ? asked : 'open');
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
