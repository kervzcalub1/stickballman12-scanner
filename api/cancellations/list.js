// GET /api/cancellations/list?view=review|verified|submitted|rejected|all&days=30|all
//   -> { ok, rows, counts:{review, verified}, canReview }
// Open work (to review / to cancel) is always listed whatever its age; `days` trims the
// finished tabs only.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listCancellations } from '../_lib/db.js';
import { VIEW_ROLES, canReview } from './_shared.js';

const VIEWS = ['review', 'verified', 'submitted', 'rejected', 'all'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, VIEW_ROLES);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 90 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const url = new URL(req.url, 'http://x');
  const view = url.searchParams.get('view') || 'review';
  if (!VIEWS.includes(view)) return send(res, 400, { ok: false, error: 'Unknown view.' });
  const raw = url.searchParams.get('days');
  const days = !raw || raw === 'all' ? null : Number(raw);
  if (days != null && !(Number.isInteger(days) && days > 0 && days <= 3650))
    return send(res, 400, { ok: false, error: 'days must be a whole number of days, or "all".' });
  try {
    const out = await listCancellations({ view, days });
    return send(res, 200, { ok: true, ...out, canReview: canReview(user) });
  } catch (e) {
    console.error('[cancellations/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load cancellations.' });
  }
}
