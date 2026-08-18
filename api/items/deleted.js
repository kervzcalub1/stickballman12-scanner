// GET /api/items/deleted?q=&from=&to=  ->  { ok, rows }
// The Deleted archive — every pair removed from inventory, newest first, searchable
// by SKU / VIN / name. Each row carries the unit's frozen history so a deleted pair
// can still be accounted for long after its items row is gone.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listDeletedItems, dbConfigured } from '../_lib/db.js';

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const url = new URL(req.url, 'http://x');
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80) || null;
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : null;
  const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : null;

  try {
    const rows = await listDeletedItems({ q, from, to });
    return send(res, 200, { ok: true, rows });
  } catch (e) {
    console.error('[items/deleted]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the deleted list.' });
  }
}
