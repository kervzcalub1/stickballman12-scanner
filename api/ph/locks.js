// PH-Team edit locks (presence, B2).
//   GET  /api/ph/locks                              -> { ok, locks:[{vin,holder,holder_id}] }
//   POST /api/ph/locks { action, vins, holderId }   -> claim | heartbeat | release
// A lock marks a unit as "being edited" so a second PH user is blocked on the
// same consolidated row. Locks self-expire via heartbeat TTL (see db.js).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  claimEditLocks, heartbeatEditLocks, releaseEditLocks, listActiveEditLocks, dbConfigured,
} from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  // Viewing presence: any report viewer. Claiming/editing: PH team (admin auto-allowed).
  if (req.method === 'GET') {
    if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
    try {
      const locks = await listActiveEditLocks();
      return send(res, 200, { ok: true, locks });
    } catch (e) {
      console.error('[ph/locks GET]', e.message);
      return send(res, 500, { ok: false, error: 'Could not load edit locks.' });
    }
  }

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 240 })) // generous — heartbeats are frequent
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });

  const body = await getJsonBody(req);
  const action = String(body.action || '');
  const vins = (Array.isArray(body.vins) ? body.vins : []).map((v) => String(v || '').trim().toUpperCase()).filter(Boolean);
  const holderId = String(body.holderId || '').slice(0, 64);
  const holder = user.name || user.username || 'PH';
  if (!holderId) return send(res, 400, { ok: false, error: 'Missing holderId.' });
  if (vins.length > 1000) return send(res, 400, { ok: false, error: 'Too many items.' });

  try {
    if (action === 'claim') {
      const r = await claimEditLocks(vins, holder, holderId);
      return send(res, r.ok ? 200 : 409, r.ok ? { ok: true } : { ok: false, error: 'Locked by another editor.', blockers: r.blockers });
    }
    if (action === 'heartbeat') {
      const held = await heartbeatEditLocks(vins, holderId);
      return send(res, 200, { ok: true, held });
    }
    if (action === 'release') {
      await releaseEditLocks(vins, holderId);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    console.error('[ph/locks POST]', e.message);
    return send(res, 500, { ok: false, error: 'Lock operation failed.' });
  }
}
