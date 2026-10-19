// GET /api/undelivered?days=90  ->  { ok, rows, marked }
//
// Every tracking number still waiting to land — PO labels + online orders — that the
// carrier has not delivered and the warehouse has not received (listUndeliveredTracking).
// Read-only and courier-free: one query over what the 17TRACK webhook already wrote.
// Selection, sorting and the CSV / PDF export are client-side (src/lib/undelivered.js).
// `marked` = numbers someone marked delivered by hand (api/undelivered/mark.js), for Undo.
import { send, applySecurity, rateLimit, requireRole } from './_lib/util.js';
import { listUndeliveredTracking, listManualDelivered, dbConfigured } from './_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // PH raise the orders and chase the courier; the warehouse is who says "it never came".
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const url = new URL(req.url, 'http://x');
  const raw = url.searchParams.get('days');
  const days = !raw || raw === 'all' ? null : Number(raw);
  if (days != null && !(Number.isInteger(days) && days > 0 && days <= 3650))
    return send(res, 400, { ok: false, error: 'days must be a whole number of days, or "all".' });

  try {
    const [rows, marked] = await Promise.all([listUndeliveredTracking({ days }), listManualDelivered({ days })]);
    return send(res, 200, { ok: true, rows, marked });
  } catch (e) {
    console.error('[undelivered]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load undelivered tracking numbers.' });
  }
}
