// POST /api/cart/file-delete  { cartId, fileId }  -> { ok, cart }
//
// Removing a file somebody uploaded. Almost always because it is the WRONG file — the
// shot before the one in focus, a receipt for a different request, the photo of the desk
// rather than the paper on it — and leaving those on the record makes "1 file on file"
// mean nothing, which is worse than the mistake.
//
// **The record of the removal outlives the file.** `file_removed` is written with the
// name and the actor BEFORE the object goes, so the trail always answers "was there
// something here?" even though the thing itself is gone. That ordering is the same rule
// `gc-reveal` follows: write the fact that somebody acted, then act.
//
// WHO: the person who uploaded it, or a buying desk. Not simply anyone who can see the
// request — being able to read a ledger is not the same as being able to edit it, and a
// receipt is the evidence half of the money.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import {
  getBuyCart, getBuyCartFile, deleteBuyCartFile, getBuyCartFull, logCartEvent, dbConfigured,
} from '../_lib/db.js';
import { hasCostPrivilege, cartVisibleTo, actorKey, redactCartForViewer, requireBuyerAccess } from '../_lib/buycart.js';
import { deleteObject, r2Configured } from '../_lib/r2.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const fileId = Number(body.fileId);
  if (!Number.isInteger(cartId) || !Number.isInteger(fileId))
    return send(res, 400, { ok: false, error: 'Which file?' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    // A finished request's evidence is settled. Nothing may be pulled out from under a
    // reconciliation that has already been signed off against it.
    if (['closed', 'cancelled', 'written_off'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'This request is finished — its files can’t be changed.' });

    const file = await getBuyCartFile(cartId, fileId);
    if (!file) return send(res, 404, { ok: false, error: 'That file is not on this request.' });

    // The uploader can undo their own mistake; a desk can clear up anybody's. A buyer is
    // additionally scoped to their own request by `cartVisibleTo` above.
    const mine = file.uploaded_by_id != null && Number(file.uploaded_by_id) === Number(user.uid);
    const desk = isPrivileged(user.role) || await hasCostPrivilege(user);
    if (!mine && !desk)
      return send(res, 403, { ok: false, error: 'Only whoever uploaded this, or a buying desk, can remove it.' });

    // Written FIRST, and it names the file. Once the object is gone this row is the only
    // thing that says it was ever here.
    await logCartEvent({
      cartId, kind: 'file_removed', actor: user,
      body: `${file.kind === 'receipt' ? 'Receipt' : 'Gift card image'} “${file.name || file.r2_key}” removed`
        + (mine ? '' : ` (uploaded by ${file.uploaded_by || 'someone else'})`),
    });

    const removed = await deleteBuyCartFile(cartId, fileId);
    // The row is gone either way. A bucket object that outlives its row is litter; a row
    // that outlives its object is a broken download button somebody will report as a bug,
    // so the row is the one that must not survive a half-failure.
    if (removed && r2Configured()) {
      try { await deleteObject(removed.r2_key); }
      catch (e) { console.warn('[cart/file-delete] bucket object left behind:', e.message); }
    }

    return send(res, 200, { ok: true, cart: redactCartForViewer(await getBuyCartFull(cartId), user) });
  } catch (e) {
    console.error('[cart/file-delete]', e.message, actorKey(user));
    return send(res, 500, { ok: false, error: 'Could not remove that file.' });
  }
}
