// POST /api/batches/delete  { batchId, reason? }  -> { ok, batchCode, units }
//
// Delete a batch: every pair in it, its boxes, its issues, the row. The pairs go
// through the same path "Remove pairs" uses (one deleted_items tombstone each) and the
// batch itself is archived as JSON in deleted_batches, so the Deleted page and the
// archive together still say what was here.
//
// Refused whole while a single pair is sold or shipped (409, naming how many): that
// money already happened. Nothing is touched in that case — a batch half-emptied
// around its sold pairs would be worse than either outcome.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { deleteBatch, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  // Tighter than bulk-status: this cannot be undone from the UI.
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const batchId = Number(body.batchId);
  const reason = String(body.reason ?? '').trim().slice(0, 500);
  if (!Number.isInteger(batchId)) return send(res, 400, { ok: false, error: 'Which batch?' });

  try {
    const out = await deleteBatch(batchId, reason, user.name || user.username);
    if (!out.ok && out.error === 'not_found') return send(res, 404, { ok: false, error: 'That batch does not exist.' });
    if (!out.ok && out.error === 'blocked') {
      const n = out.blocked.length;
      return send(res, 409, {
        ok: false, blocked: out.blocked,
        error: `${n} pair${n === 1 ? '' : 's'} in this batch ${n === 1 ? 'is' : 'are'} already sold or shipped — a batch with sold stock cannot be deleted. Remove the unsold pairs instead.`,
      });
    }
    return send(res, 200, { ok: true, batchCode: out.batchCode, units: out.units });
  } catch (e) {
    console.error('[batches/delete]', e.message);
    return send(res, 500, { ok: false, error: 'Could not delete that batch.' });
  }
}
