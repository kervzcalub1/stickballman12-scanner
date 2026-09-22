// POST /api/rescale-requests/audit-scan { id, code } -> { ok, kind, size, vin?, name?, warn? }
//
// The audit's scan path. Brent counts a shelf by scanning, not by typing a number into a
// box — and the two are not the same claim. A typed 3 is somebody's assertion; three
// scans are three pairs that were each in a hand. It also catches the two mistakes a
// shelf count actually makes: the same pair counted twice, and a pair of a DIFFERENT
// shoe that shares the shelf.
//
// Resolution is server-side because only the server knows what this request is for: the
// style code to match against (including the dual code a re-released shoe carries), and
// what our own stock says a box barcode is. One round trip per scan, so the gun can keep
// firing.
//
// It does NOT write anything. The count is still submitted in one go by /audit — a scan
// that half-committed would leave a shelf count nobody could re-do.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { resolveAuditScan, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  // A gun fires fast and a shelf can hold a hundred pairs; this is one lookup, no write.
  if (!rateLimit(req, { windowMs: 60_000, max: 600 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const id = Number(body.id) || 0;
  if (!id) return send(res, 400, { ok: false, error: 'Missing request id.' });

  try {
    const r = await resolveAuditScan({ requestId: id, code: body.code });
    // A scan that resolves to nothing is a 409, not a 500: it is an answer about the
    // shoe in somebody's hand, and the screen has to say what to do about it.
    if (r.error) return send(res, 409, { ok: false, error: r.error });
    return send(res, 200, { ok: true, ...r });
  } catch (e) {
    console.error('[rescale-requests/audit-scan]', e.message);
    return send(res, 500, { ok: false, error: 'Could not read that scan.' });
  }
}
