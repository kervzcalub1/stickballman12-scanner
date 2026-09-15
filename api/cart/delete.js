// POST /api/cart/delete  { cartId, reason? }  -> { ok, cartCode }
//
// Deleting a buying request, as opposed to cancelling it. Cancel keeps the row and
// says why; delete removes it and every table under it, leaving one archived JSON
// tombstone (`deleted_buy_carts`) the way a removed pair leaves one in deleted_items.
//
// WHO. Anyone who can reach the request: the buyer on their own, any staff account on
// any. With ONE exception, which is the whole reason this is an endpoint and not a
// button: once gift cards have been issued against a request there is company money
// on it, and the person who asked for that money does not get to make the record of
// it disappear. A buyer's delete on a carded request answers 403 and names the person
// who can — an approver. Staff who are not approvers get the same answer: the desk
// that decided the money is the desk that can erase it.
//
// A request that already raised a purchase order is refused (409) — the order is the
// supplier's shipment and has its own delete, which is where that decision belongs.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getBuyCart, deleteBuyCart, countBuyCartGiftCards, dbConfigured } from '../_lib/db.js';
import { cartVisibleTo, requireBuyerAccess, hasPrivilege } from '../_lib/buycart.js';
import { deleteObject, r2Configured } from '../_lib/r2.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  // This cannot be undone from the UI, so a stuck button costs real rows.
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const reason = String(body.reason ?? '').trim().slice(0, 500);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'Which buying request?' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });

    // Money on it: any card ever issued, voided or not — a voided card is still a card
    // that went out — or a funded total the ledger says was covered.
    const carded = Number(cart.gc_total) > 0 || (await countBuyCartGiftCards(cartId)) > 0;
    if (carded && !isPrivileged(user.role) && !(await hasPrivilege(user, 'approve_buying'))) {
      return send(res, 403, {
        ok: false,
        error: user.role === 'supplier'
          ? 'This request has gift cards on it. Only an approver can delete a request once cards have been issued — ask them, or leave it to be reconciled.'
          : 'This request has gift cards on it. Only an approver can delete it.',
      });
    }
    if (cart.po_id) {
      return send(res, 409, {
        ok: false,
        error: 'This request already raised a purchase order. Delete or cancel the order first — the request goes with it.',
      });
    }

    const out = await deleteBuyCart(cartId, reason, user);
    if (!out) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    // Rows first, objects second, best effort: a leftover object is a dangling file in
    // the bucket, which is a cost; a missing object under a live row would be a broken
    // download, which is a bug. Only the first can happen from here.
    if (r2Configured()) {
      for (const key of out.r2Keys) {
        try { await deleteObject(key); } catch (e) { console.error('[cart/delete] r2', key, e.message); }
      }
    }
    return send(res, 200, { ok: true, cartCode: out.cartCode });
  } catch (e) {
    console.error('[cart/delete]', e.message);
    return send(res, 500, { ok: false, error: 'Could not delete that request.' });
  }
}
