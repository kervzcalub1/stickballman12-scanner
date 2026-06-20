// POST /api/items/bulk-status  { vins:[], status }  ->  { ok, updated }
// Report-page bulk status change. Updates each item and logs a status_change
// event to its history. Auth required.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { bulkSetStatus, dbConfigured } from '../_lib/db.js';
import { STATUS_KEYS } from '../_lib/statuses.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vins = Array.isArray(body.vins)
    ? [...new Set(body.vins.map((v) => String(v).trim().toUpperCase()).filter(Boolean))].slice(0, 1000)
    : [];
  const status = String(body.status || '');
  if (!vins.length) return send(res, 400, { ok: false, error: 'Select at least one item.' });
  if (!STATUS_KEYS.includes(status)) return send(res, 400, { ok: false, error: 'Invalid status.' });

  try {
    const updated = await bulkSetStatus(vins, status, user.name || user.username || '');
    return send(res, 200, { ok: true, updated });
  } catch (e) {
    console.error('[items/bulk-status]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update statuses.' });
  }
}
