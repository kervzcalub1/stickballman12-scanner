// POST /api/cart/task  { cartId, task:{...} }                         -> open one
// POST /api/cart/task  { cartId, taskId, patch:{...} }                -> update an open one
// POST /api/cart/task  { cartId, taskId, close:{ status, resolution, refundAmount } }
//
// The exception path. Everything above this file is the happy road: approve, fund, buy,
// pack, ship, receive, reconcile. What actually costs the company money is the other
// road — a wrong pair bought, a box that never turned up, a refund that was promised and
// never posted — and until now those had nowhere to live except a chat message.
//
// ONE table for both follow-ups and return cases rather than two, because the rule is a
// single sentence: every open item has an OWNER, a NEXT ACTION, a DUE DATE and EVIDENCE.
// Two mechanisms that each half-satisfy that is how a queue ends up with two answers to
// "what is still outstanding".
//
// A RETURN CASE is that same row with the facts a return needs — which pairs, what they
// cost, and the retailer's own final return date, which is the deadline that actually
// bites. And it closes on a rule of its own: **returned is not refunded.** The shoes
// leaving the building says the retailer has them, not that the money came back.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import {
  getBuyCart, getBuyCartFull, addCartTask, updateCartTask, closeCartTask, dbConfigured,
} from '../_lib/db.js';
import { requirePrivilege } from '../_lib/buycart.js';

const KINDS = ['return', 'shortage', 'followup'];
const text = (v, n = 200) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
const int = (v) => { const n = Math.trunc(Number(v)); return Number.isInteger(n) && n > 0 ? n : null; };
// A date, or nothing. `YYYY-MM-DD` only: a due date is a day on a calendar, and letting
// a timestamp through here is how an EST deadline starts reading as the day before.
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '').trim()) ? String(v).trim() : null);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  // Opening, chasing and closing a case are all decisions about company money, so they
  // sit behind the approval privilege — read from the database on every call, like every
  // privilege in this flow. A buyer can be the OWNER of a case; they cannot declare
  // their own case resolved.
  const user = await requirePrivilege(req, res, 'approve_buying',
    'Only a buying desk can open or resolve a case on a request.');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (['closed', 'cancelled'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'This request is finished — a case cannot be opened or changed on it.' });

    // ---- close ------------------------------------------------------------
    if (body.close) {
      const taskId = Number(body.taskId);
      if (!Number.isInteger(taskId)) return send(res, 400, { ok: false, error: 'Which case?' });
      const status = body.close.status === 'written_off' ? 'written_off' : 'resolved';
      const resolution = text(body.close.resolution, 500);
      // A case closed with no account of how is a record that somebody ticked a box.
      if (!resolution)
        return send(res, 400, { ok: false, error: 'Say how it ended — a case closed with no resolution records nothing.' });
      const refundAmount = money(body.close.refundAmount);
      const out = await closeCartTask({ cartId, taskId, status, resolution, refundAmount, actor: user });
      if (!out) return send(res, 409, { ok: false, error: 'That case is not open.' });
      return send(res, 200, { ok: true, cart: await getBuyCartFull(cartId) });
    }

    // ---- update -----------------------------------------------------------
    if (body.patch) {
      const taskId = Number(body.taskId);
      if (!Number.isInteger(taskId)) return send(res, 400, { ok: false, error: 'Which case?' });
      const out = await updateCartTask({
        cartId, taskId, actor: user,
        patch: {
          nextAction: text(body.patch.nextAction, 400),
          ownerName: text(body.patch.ownerName, 120),
          dueDate: date(body.patch.dueDate),
          returnTracking: text(body.patch.returnTracking, 80),
          refundAmount: money(body.patch.refundAmount),
        },
      });
      if (!out) return send(res, 409, { ok: false, error: 'That case is not open.' });
      return send(res, 200, { ok: true, cart: await getBuyCartFull(cartId) });
    }

    // ---- open -------------------------------------------------------------
    const t = body.task || {};
    const kind = KINDS.includes(t.kind) ? t.kind : 'followup';
    const title = text(t.title, 200);
    if (!title) return send(res, 400, { ok: false, error: 'Say what the case is.' });
    const ownerName = text(t.ownerName, 120);
    const dueDate = date(t.dueDate);
    // The deck's rule, enforced rather than printed on a slide: an item with no owner
    // and no date is not a task, it is a hope. Every other field is optional.
    if (!ownerName || !dueDate)
      return send(res, 400, { ok: false, error: 'Every open case needs an owner and a due date.' });

    const task = await addCartTask({
      cartId, actor: user,
      task: {
        kind, title, ownerName, dueDate,
        nextAction: text(t.nextAction, 400),
        ownerUserId: Number(t.ownerUserId) || null,
        sku: text(t.sku, 60), size: text(t.size, 20), qty: int(t.qty),
        costAtRisk: money(t.costAtRisk), holder: text(t.holder, 120),
        // The retailer's own cutoff, which is the date that decides whether this is
        // recoverable at all. Kept apart from our internal due date on purpose: ours can
        // be moved, theirs cannot.
        returnBy: date(t.returnBy),
      },
    });
    return send(res, 200, { ok: true, task, cart: await getBuyCartFull(cartId) });
  } catch (e) {
    console.error('[cart/task]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record that case.' });
  }
}
