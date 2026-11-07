// POST /api/ebay-sync/run { pass:'queue'|'reconcile'|'content'|'create', acceptCounts? } -> { ok, started }
// acceptCounts (reconcile only) accepts the new, smaller Shopify / eBay counts for that one pass, after the shrink guard stopped it.
// Runs the pass now, in the background. Admin or "Connect integrations".
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { requirePrivilege } from '../_lib/buycart.js';
import { dbConfigured } from '../_lib/db.js';
import { runPass, PASSES, passRunning } from '../_lib/ebay-sync.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'connect_integrations', 'Running eBay Sync needs an admin, or the “Connect integrations” privilege.');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const body = await getJsonBody(req);
  if (!PASSES.includes(body.pass)) return send(res, 400, { ok: false, error: `Pass must be one of ${PASSES.join(', ')}.` });
  if (passRunning(body.pass)) return send(res, 200, { ok: true, started: false, running: true });
  runPass(body.pass, { by: user.name || user.username || '', acceptCounts: body.pass === 'reconcile' && body.acceptCounts === true }).catch((e) => console.error('[ebay-sync] run', e.message));
  return send(res, 200, { ok: true, started: true });
}
