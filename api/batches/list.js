// GET /api/batches/list?kind=…&q=…  ->  { ok, batches }
// Recent receiving batches with item counts/totals.
//
// `q` searches instead of listing — by the tracking number on the parcel (batch-level or
// any box's), or the batch code. That runs in SQL across every batch rather than
// filtering this window, because the box in someone's hand is as likely to be from March
// as from this week (see searchBatches).
//
// PH READS THIS TOO (2026-08-27). They price what the warehouse receives, so "which
// batch did this parcel become" is their question as much as the floor's — but
// PH_EXCLUDED_KINDS still holds: in-store buys and existing stock are invisible to them,
// enforced HERE from the session role, never from a query parameter the client sends.
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { listBatches, searchBatches, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const params = new URL(req.url, 'http://x').searchParams;
  const kindParam = params.get('kind');
  const kind = ['rescale', 'receiving', 'instore', 'existing'].includes(kindParam) ? kindParam : null;
  const q = (params.get('q') || '').trim().slice(0, 64);
  const phSafe = user.role === 'ph_team';
  try {
    const batches = q ? await searchBatches(q, { phSafe }) : await listBatches(100, kind, { phSafe });
    return send(res, 200, { ok: true, batches, searched: !!q });
  } catch (e) {
    console.error('[batches/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load batches.' });
  }
}
