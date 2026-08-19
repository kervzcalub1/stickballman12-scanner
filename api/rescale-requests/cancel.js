// POST /api/rescale-requests/cancel { id, note? } -> { ok }
// PH cancels a rescale request it raised — wrong SKU, changed its mind, already
// sorted out. The request leaves the warehouse's Pending-audit queue and the home
// badge (both count status='open').
//
// PH TEAM ONLY, and deliberately not via requireRole: that auto-allows admin, and
// this is the requesting team's own call to make. Same explicit check the other
// PH-owned writes use (api/ph/update.js, api/ph/set-goat.js) — ph_team, plus
// superadmin because that env account IS the PH workspace.
//
// Only an `open` request can be cancelled; `cancelRescaleRequest` enforces that in
// SQL, so an audit landing at the same moment wins and we answer 409 rather than
// discarding a shelf count somebody just made.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth } from '../_lib/util.js';
import { cancelRescaleRequest, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (user.role !== 'ph_team' && user.role !== 'superadmin')
    return send(res, 403, { ok: false, error: 'Only PH Team can cancel a rescale request.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const id = Number(body.id) || 0;
  if (!id) return send(res, 400, { ok: false, error: 'Missing request id.' });
  const note = String(body.note || '').trim().slice(0, 500) || null;

  try {
    const r = await cancelRescaleRequest(id, note, user.name || user.username || '');
    if (!r.ok) {
      if (!r.status) return send(res, 404, { ok: false, error: 'That request no longer exists.' });
      if (r.status === 'cancelled') return send(res, 409, { ok: false, error: 'This request was already cancelled.' });
      return send(res, 409, {
        ok: false,
        error: 'Too late to cancel — the warehouse has already audited this one. Reload to see their count.',
      });
    }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[rescale-requests/cancel]', e.message);
    return send(res, 500, { ok: false, error: 'Could not cancel the request.' });
  }
}
