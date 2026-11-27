// POST /api/cancellations/action  { id, action: 'remove', reason } | { id, action: 'submit' | 'unsubmit' } -> { ok, row }
// 'submit' = the INTERNAL "sent to the platform for cancellation" tick (who + when on the row;
// nothing is sent anywhere); 'unsubmit' takes it back. Anyone who sees the page.
// There is no review step any more (2026-11-12): the one action left is REMOVE — a photo
// that wasn't an order to cancel, sent by mistake. The row is kept (status 'rejected' in the
// database, with who and why in cancellation_events) but never listed or put in a message,
// and its number may be recorded again. PH / admin, or whoever sent it.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, getCancellation, removeCancellation, markCancellationSubmitted } from '../_lib/db.js';
import { VIEW_ROLES, canRemove, actorOf, idOf, text } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, VIEW_ROLES);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const id = idOf(b.id);
  if (!id) return send(res, 400, { ok: false, error: 'Which cancellation?' });
  if (!['remove', 'submit', 'unsubmit'].includes(b.action)) return send(res, 400, { ok: false, error: 'Unknown action.' });
  try {
    const cur = await getCancellation(id);
    if (!cur) return send(res, 404, { ok: false, error: 'That cancellation does not exist.' });
    if (b.action !== 'remove') {
      const on = b.action === 'submit';
      if (cur.status === 'rejected') return send(res, 409, { ok: false, error: 'That row was removed.' });
      if (on && !cur.order_number) return send(res, 400, { ok: false, error: 'Type the order number first.' });
      const row = await markCancellationSubmitted(id, { actor: actorOf(user), on });
      // Someone else got there first: the row already says so — hand it back as it is.
      return send(res, 200, { ok: true, row: row || await getCancellation(id) });
    }
    if (!canRemove(user, cur)) return send(res, 403, { ok: false, error: 'Only PH, an admin or whoever sent it can remove it.' });
    const reason = text(b.reason, 300);
    if (!reason) return send(res, 400, { ok: false, error: 'Say why it is removed.' });
    const row = await removeCancellation(id, { actor: actorOf(user), reason });
    if (!row) return send(res, 409, { ok: false, error: 'It was already removed.' });
    return send(res, 200, { ok: true, row });
  } catch (e) {
    console.error('[cancellations/action]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save that.' });
  }
}
