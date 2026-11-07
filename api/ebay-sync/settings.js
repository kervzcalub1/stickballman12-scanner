// POST /api/ebay-sync/settings { switches?:{stock|price|content|create|end:'off'|'shadow'|'live'}, kill?, blastPct? } -> { ok, settings }
// Admin or "Connect integrations" only. Every change is logged with who.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { requirePrivilege } from '../_lib/buycart.js';
import { dbConfigured } from '../_lib/db.js';
import { saveSettings } from '../_lib/ebay-sync.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'connect_integrations', 'Changing eBay Sync needs an admin, or the “Connect integrations” privilege.');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const body = await getJsonBody(req);
  return send(res, 200, { ok: true, settings: await saveSettings(body, user.name || user.username || '') });
}
