// GET  /api/presell-listings/settings          -> { ok, allSalesSince, groupSet, canEdit }
// POST /api/presell-listings/settings { allSales: bool }   (admin)
// The TEST switch for alerting REGULAR (non-pre-sell) Alias/StockX sales to the pre-sell
// group (docs/context/presell-listings.md). Stored as the moment it was switched on, so
// only orders placed after that alert.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { dbConfigured, getSetting, setSetting } from '../_lib/db.js';
import { presellChatId } from '../_lib/telegram.js';

const KEY = 'sales_alert_all_since';

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const canEdit = isPrivileged(user.role);
  if (req.method === 'POST') {
    if (!canEdit) return send(res, 403, { ok: false, error: 'Admin access required.' });
    const b = await getJsonBody(req);
    await setSetting(KEY, b.allSales === true ? new Date().toISOString() : '', user.name || user.username || null);
  } else if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const since = await getSetting(KEY);
  return send(res, 200, { ok: true, allSalesSince: since || null, groupSet: !!presellChatId(), canEdit });
}
