// GET /api/po/lookup?q=  (warehouse / admin)
// Resolve a PO for receiving by its code (PO-xxxxx) or by a label's tracking
// number — so staff can scan a shipping label to pull up the order. Returns the
// full PO (header + labels + expected lines).
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { lookupPoByCodeOrTracking, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
  if (!q.trim()) return send(res, 400, { ok: false, error: 'Provide a PO code or tracking number.' });

  try {
    const data = await lookupPoByCodeOrTracking(q);
    if (!data) return send(res, 404, { ok: false, error: `No purchase order found for "${q.trim()}".` });
    return send(res, 200, { ok: true, ...data });
  } catch (e) {
    console.error('[po/lookup]', e.message);
    return send(res, 500, { ok: false, error: 'Lookup failed.' });
  }
}
