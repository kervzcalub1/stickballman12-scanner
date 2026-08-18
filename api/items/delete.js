// POST /api/items/delete  { vins:[], reason }  ->  { ok, deleted, blocked }
// Remove pairs from inventory outright — the miscount fix behind "Remove" on the
// warehouse Inventory page and the PH New Inventory grid. Each unit is archived to
// `deleted_items` (whole row + full history) before the row is deleted, because
// item_events cascades away with it.
//
// Warehouse AND PH team can do this: both count stock, and both were finding rows
// they had no way to correct. Sold/shipped pairs are refused server-side.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { deleteItems, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // requireRole already auto-allows admin/superadmin and blocks a forced password change.
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  // Deliberately tighter than bulk-status (30/min): this one can't be undone from
  // the UI, so a runaway loop or a stuck button costs real rows.
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vins = Array.isArray(body.vins)
    ? [...new Set(body.vins.map((v) => String(v).trim().toUpperCase()).filter(Boolean))].slice(0, 200)
    : [];
  const reason = String(body.reason || '').trim().slice(0, 200) || null;
  if (!vins.length) return send(res, 400, { ok: false, error: 'Select at least one pair to remove.' });

  try {
    const by = user.name || user.username || '';
    const { deleted, blocked } = await deleteItems(vins, reason, by);
    if (!deleted.length && blocked.length) return send(res, 409, {
      ok: false, blocked,
      error: `Can’t remove ${blocked.length} already-finalized pair${blocked.length === 1 ? '' : 's'} (sold/shipped): ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? '…' : ''}`,
    });
    return send(res, 200, { ok: true, deleted, blocked });
  } catch (e) {
    console.error('[items/delete]', e.message);
    return send(res, 500, { ok: false, error: 'Could not remove those pairs.' });
  }
}
