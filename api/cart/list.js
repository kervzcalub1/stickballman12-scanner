// GET /api/cart/list[?status=][&buyer=<id>]  -> { ok, carts:[…], counts:{…}, buyers:[…] }
//
// The queue screen for every desk, and the buyer's own list. A BUYER is scoped to their
// own requests off the token — never off a query parameter, which would turn one
// buyer's spending history into a URL anybody could edit.
import { send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { requireBuyerAccess } from '../_lib/buycart.js';
import { listBuyCarts, listBuyCartBuyers, buyCartPendingCounts, dbConfigured } from '../_lib/db.js';

const STATUSES = ['draft', 'submitted', 'approved', 'denied', 'funded', 'receipted', 'audited', 'closed', 'cancelled', 'written_off'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const params = new URL(req.url, 'http://x').searchParams;
  const status = STATUSES.includes(params.get('status')) ? params.get('status') : null;
  // 'open' = still moving, 'done' = ended (closed, cancelled, written off, denied).
  const view = ['open', 'done'].includes(params.get('view')) ? params.get('view') : null;
  // Fail CLOSED on a uid that isn't a real row id: scoped to -1 (nothing) rather than
  // reaching the query as NaN, which is the wrong kind of surprise on a money screen.
  const isBuyer = user.role === 'supplier' && !isPrivileged(user.role);
  const uid = Number(user.uid);
  const buyerUserId = isBuyer ? (Number.isInteger(uid) && uid > 0 ? uid : -1) : null;

  // Filtering by buyer is a STAFF thing, and it is ignored outright for a buyer rather
  // than merely being unavailable in their UI: `?buyer=` on a buyer's own request would
  // otherwise read as an attempt to widen their scope, and the safe answer to that is to
  // drop it on the floor. Their own scoping is ANDed in regardless.
  const buyerParam = Number(params.get('buyer'));
  const buyerId = !isBuyer && Number.isInteger(buyerParam) && buyerParam > 0 ? buyerParam : null;

  try {
    const carts = await listBuyCarts({ buyerUserId, status, buyerId, view });
    // Desk counts are a staff thing — a buyer has no queue to hold up.
    const counts = isBuyer ? null : await buyCartPendingCounts();
    // The dropdown's options come from the whole table, not from the page above: the
    // list is capped, so options built from `carts` would omit anyone whose requests had
    // all scrolled off — and a filter that cannot name somebody hides them twice over.
    const buyers = isBuyer ? null : await listBuyCartBuyers();
    return send(res, 200, { ok: true, carts, counts, buyers });
  } catch (e) {
    console.error('[cart/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load buying requests.' });
  }
}
