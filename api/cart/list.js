// GET /api/cart/list[?status=]  -> { ok, carts:[…], counts:{…} }
//
// The queue screen for every desk, and the buyer's own list. A BUYER is scoped to their
// own requests off the token — never off a query parameter, which would turn one
// buyer's spending history into a URL anybody could edit.
import { send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { listBuyCarts, buyCartPendingCounts, dbConfigured } from '../_lib/db.js';

const STATUSES = ['draft', 'submitted', 'approved', 'denied', 'funded', 'receipted', 'audited', 'closed', 'cancelled'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const params = new URL(req.url, 'http://x').searchParams;
  const status = STATUSES.includes(params.get('status')) ? params.get('status') : null;
  // Fail CLOSED on a uid that isn't a real row id: scoped to -1 (nothing) rather than
  // reaching the query as NaN, which is the wrong kind of surprise on a money screen.
  const isBuyer = user.role === 'supplier' && !isPrivileged(user.role);
  const uid = Number(user.uid);
  const buyerUserId = isBuyer ? (Number.isInteger(uid) && uid > 0 ? uid : -1) : null;

  try {
    const carts = await listBuyCarts({ buyerUserId, status });
    // Desk counts are a staff thing — a buyer has no queue to hold up.
    const counts = isBuyer ? null : await buyCartPendingCounts();
    return send(res, 200, { ok: true, carts, counts });
  } catch (e) {
    console.error('[cart/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load buying requests.' });
  }
}
