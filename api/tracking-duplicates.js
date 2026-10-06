// GET  /api/tracking-duplicates?status=open|handled&supplier=&q=  -> { ok, rows, bySupplier }
// POST /api/tracking-duplicates { id, handled:bool, note? }        -> { ok, row }
//
// The duplicate tracking number log (docs/context/receiving.md, "Duplicate tracking
// numbers"): every package received under a number we had already received, written by
// the server at commit time. The warehouse reads it; an ADMIN closes an entry as handled
// with a note — told the supplier, or decided to leave it (Alexander's call on the Foot
// Locker case). A note is required to close one: "handled" with no reason audits nothing.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from './_lib/util.js';
import { dbConfigured, listTrackingDuplicates, setTrackingDuplicateStatus } from './_lib/db.js';

const isAdmin = (u) => u?.role === 'admin' || u?.role === 'superadmin';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  if (req.method === 'GET') {
    const p = new URL(req.url, 'http://x').searchParams;
    const status = ['open', 'handled'].includes(p.get('status')) ? p.get('status') : null;
    const supplier = String(p.get('supplier') || '').trim().slice(0, 120) || null;
    const q = String(p.get('q') || '').trim().slice(0, 60) || null;
    try {
      const { rows, bySupplier } = await listTrackingDuplicates({ status, supplier, q });
      return send(res, 200, { ok: true, rows, bySupplier });
    } catch (e) {
      console.error('[tracking-duplicates]', e.message);
      return send(res, 500, { ok: false, error: 'Could not load the log.' });
    }
  }

  if (!isAdmin(user)) return send(res, 403, { ok: false, error: 'Only an admin can close an entry.' });
  const b = await getJsonBody(req);
  const id = Number(b.id);
  if (!Number.isSafeInteger(id) || id <= 0) return send(res, 400, { ok: false, error: 'Which entry?' });
  const note = String(b.note ?? '').trim().slice(0, 500);
  if (b.handled && !note) return send(res, 400, { ok: false, error: 'Say what was decided — told the supplier, or left it.' });
  try {
    const row = await setTrackingDuplicateStatus(id, { handled: !!b.handled, note }, user.name || user.username || null);
    if (!row) return send(res, 404, { ok: false, error: 'That entry no longer exists.' });
    return send(res, 200, { ok: true, row });
  } catch (e) {
    console.error('[tracking-duplicates]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save.' });
  }
}
