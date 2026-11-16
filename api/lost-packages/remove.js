// Lost Package Tracker Tool — take findings off a run, or put them back
// (docs/context/lost-packages.md → "Removing findings").
//   POST /api/lost-packages/remove  { runId, ids: [lost_pkg_orders.id …], removed: true | false }
//     -> { ok, changed }
// A removed order leaves the list, the totals and both Excel downloads; the row is kept with
// who removed it and when, so it can be put back. Refused while Phase 2 is running (409) —
// the worker may be mid-way through that very order.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getLostRun, setLostOrdersRemoved, dbConfigured } from '../_lib/db.js';

const MAX_IDS = 5000;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);   // admin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const b = await getJsonBody(req);
    const runId = Number(b.runId);
    if (!Number.isInteger(runId)) return send(res, 400, { ok: false, error: 'Which run?' });
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return send(res, 400, { ok: false, error: 'No orders were picked.' });
    if (ids.length > MAX_IDS) return send(res, 400, { ok: false, error: `Too many at once (${ids.length}). Pick at most ${MAX_IDS}.` });
    const run = await getLostRun(runId);
    if (!run) return send(res, 404, { ok: false, error: 'That run is gone.' });
    if (run.p2_status === 'running') return send(res, 409, { ok: false, error: 'Phase 2 is checking this run. Pause it or wait for it to finish, then try again.' });
    const changed = await setLostOrdersRemoved(runId, ids, b.removed !== false, user.name || user.username || null);
    return send(res, 200, { ok: true, changed });
  } catch (e) {
    console.error('[lost-packages/remove]', e.message);
    return send(res, 500, { ok: false, error: 'Could not change those orders.' });
  }
}
