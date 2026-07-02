// POST /api/items/bulk-status  { vins:[], status }  ->  { ok, updated }
// Report-page bulk status change. Updates each item and logs a status_change
// event to its history. Auth required.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { bulkSetStatus, getStatusesByVins, dbConfigured } from '../_lib/db.js';
import { STATUS_KEYS, isTerminalStatus } from '../_lib/statuses.js';

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
    // Guard: don't let a sold/shipped unit be reactivated into an active status
    // (double-sell risk). sold→shipped / shipped→sold stay allowed (both terminal).
    if (!isTerminalStatus(status)) {
      const cur = await getStatusesByVins(vins);
      const blocked = vins.filter((v) => isTerminalStatus(cur[v]));
      if (blocked.length) return send(res, 409, {
        ok: false,
        blocked,
        error: `Can't reactivate ${blocked.length} already-finalized item${blocked.length === 1 ? '' : 's'} (sold/shipped) as "${status}". Deselect: ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? '…' : ''}`,
      });
    }
    const updated = await bulkSetStatus(vins, status, user.name || user.username || '');
    return send(res, 200, { ok: true, updated });
  } catch (e) {
    console.error('[items/bulk-status]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update statuses.' });
  }
}
