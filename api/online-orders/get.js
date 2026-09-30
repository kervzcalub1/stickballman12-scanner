// GET /api/online-orders/get?id=N -> { ok, order, events }
// One order with its lines, each pair's actual cost, and the history (created, edited,
// a line cancelled, a refund requested / received, counted in by the warehouse).
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getOnlineOrder, onlineOrderEvents } from '../_lib/db.js';
import { shapeOrder, idOf } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team', 'warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const id = idOf(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!id) return send(res, 400, { ok: false, error: 'Which order?' });
  try {
    const o = await getOnlineOrder(id);
    if (!o) return send(res, 404, { ok: false, error: 'That order no longer exists.' });
    const events = await onlineOrderEvents(id);
    return send(res, 200, { ok: true, order: shapeOrder(o), events });
  } catch (e) {
    console.error('[online-orders/get]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load that order.' });
  }
}
