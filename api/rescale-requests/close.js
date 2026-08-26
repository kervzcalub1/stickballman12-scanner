// POST /api/rescale-requests/close { id } -> { ok }
// The end of the loop: the pairs this request was raised for have been dealt with —
// re-listed, or the count settled. `audited` used to be terminal, so the green
// "Audited" home badge counted up forever and the linked pairs never left the PH
// grid's Rescale tab.
//
// PH TEAM ONLY, via the same explicit check as cancel/update — `requireRole` would
// auto-allow admin, and finishing the listing work is the PH team's own call. Only from
// `audited`: closing something nobody has counted would throw away the ask.
import { send, applySecurity, rateLimit, requireAuth, getJsonBody } from '../_lib/util.js';
import { closeRescaleRequest, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (user.role !== 'ph_team' && user.role !== 'superadmin')
    return send(res, 403, { ok: false, error: 'Only PH Team can close a rescale request.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const id = Number(body.id) || 0;
  if (!id) return send(res, 400, { ok: false, error: 'Missing request id.' });

  try {
    const r = await closeRescaleRequest(id, user.name || user.username || '');
    if (!r.ok) {
      if (!r.status) return send(res, 404, { ok: false, error: 'That request no longer exists.' });
      if (r.status === 'closed') return send(res, 409, { ok: false, error: 'This request is already closed.' });
      if (r.status === 'open') return send(res, 409, { ok: false, error: 'The warehouse hasn\u2019t counted this shelf yet — there is nothing to close.' });
      return send(res, 409, { ok: false, error: 'This request was cancelled.' });
    }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[rescale-requests/close]', e.message);
    return send(res, 500, { ok: false, error: 'Could not close the request.' });
  }
}
