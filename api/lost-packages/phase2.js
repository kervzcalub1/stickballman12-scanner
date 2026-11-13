// Lost Package Tracker Tool — Phase 2's buttons (docs/context/lost-packages.md).
//   POST /api/lost-packages/phase2  { runId, action: start | pause | resume | stop | recheck }
//     -> { ok, status }
// The checking itself is api/_lib/lostpkg-worker.js on the server; this only moves the run's
// state and kicks the worker. 409 when the move isn't allowed from where the run is now.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { setLostPhase2, getLostRun, deleteLostRun, dbConfigured } from '../_lib/db.js';
import { carriersConfigured, missingCarrierKeys } from '../_lib/lostpkg-carriers.js';
import { kickLostPackages } from '../_lib/lostpkg-worker.js';

const ACTIONS = new Set(['start', 'pause', 'resume', 'stop', 'recheck', 'delete']);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const b = await getJsonBody(req);
  const runId = Number(b.runId);
  const action = String(b.action || '');
  if (!Number.isInteger(runId) || !ACTIONS.has(action)) return send(res, 400, { ok: false, error: 'Which run, and which action?' });

  try {
    const run = await getLostRun(runId);
    if (!run) return send(res, 404, { ok: false, error: 'That run is gone.' });
    if (action === 'delete') {
      if (run.p2_status === 'running') return send(res, 409, { ok: false, error: 'Stop Phase 2 first, then delete the run.' });
      await deleteLostRun(runId);
      return send(res, 200, { ok: true, status: 'deleted' });
    }
    if (['start', 'resume', 'recheck'].includes(action)) {
      if (!carriersConfigured())
        return send(res, 409, { ok: false, error: `Phase 2 isn’t set up on this server yet — missing ${missingCarrierKeys().join(', ')}.` });
      if (Number(run.uploaded) < Number(run.order_count))
        return send(res, 409, { ok: false, error: 'This run’s orders didn’t finish saving. Scan the workbook again.' });
    }
    const status = await setLostPhase2(runId, action, user.name || user.username || null);
    if (!status) return send(res, 409, { ok: false, error: `Phase 2 can’t ${action} from “${run.p2_status}”. Refresh and try again.` });
    if (status === 'running') kickLostPackages();
    return send(res, 200, { ok: true, status });
  } catch (e) {
    console.error('[lost-packages/phase2]', e.message);
    return send(res, 500, { ok: false, error: 'Could not change Phase 2.' });
  }
}
