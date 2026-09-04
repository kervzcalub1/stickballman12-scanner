// POST /api/cart/gc-reveal  { cartId, gcId }  -> { ok, code, pin }
//
// The ONE way a stored gift card code comes back out, and it writes the audit row
// BEFORE it decrypts. That ordering is the point: if the reveal fails halfway, the
// record still shows that somebody asked, which is the question an auditor is actually
// trying to answer — "who could have spent this".
//
// Who may: the people who issue the cards, and the BUYER whose request it is, because
// they are the one who has to type the number into a till. Nobody else — a card on a
// staff screen that has no reason to hold it is a code somebody can photograph.
//
// Deliberately rate-limited hard. A reveal is a deliberate act a handful of times a
// day; anything that looks like a sweep of the table is not that.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, isPrivileged, blockIfMustChange } from '../_lib/util.js';
import { getBuyCart, getBuyCartGiftCardSecret, logCartEvent, dbConfigured } from '../_lib/db.js';
import { decryptSecret, secretsConfigured } from '../_lib/secrets.js';
import { hasPrivilege } from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Two different people may read a card and they qualify two different ways: the desk
  // that issued it (a privilege) and the buyer who has to type it into a till (their own
  // request, and only once it has been released). A single role list can't say that, so
  // authorise first and branch below.
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  const isBuyer = user.role === 'supplier' && !isPrivileged(user.role);
  if (!isBuyer && !(await hasPrivilege(user, 'issue_gift_cards')))
    return send(res, 403, { ok: false, error: 'You do not have access to gift card numbers.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Too many card look-ups. Wait a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!secretsConfigured())
    return send(res, 503, { ok: false, error: 'Gift card codes can’t be read on this server (BUY_GC_KEY is not set).' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const gcId = Number(body.gcId);
  if (!Number.isInteger(cartId) || !Number.isInteger(gcId))
    return send(res, 400, { ok: false, error: 'A valid cartId and gcId are required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    // A buyer reads only their OWN cards, and only once the request is released — a
    // code visible before funding is a code that could be spent before it was approved.
    if (user.role === 'supplier' && !isPrivileged(user.role)) {
      if (Number(cart.buyer_user_id) !== Number(user.uid))
        return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
      if (!['funded', 'receipted', 'audited', 'closed'].includes(cart.status))
        return send(res, 409, { ok: false, error: 'These cards have not been released to you yet.' });
    }

    const row = await getBuyCartGiftCardSecret(cartId, gcId);
    if (!row) return send(res, 404, { ok: false, error: 'That card does not exist.' });

    // The trail first, the secret second.
    await logCartEvent({
      cartId, kind: 'gc_revealed', gcId, actor: user,
      body: `•••• ${row.code_last4 || '????'} · $${Number(row.balance).toFixed(2)}`,
    });

    return send(res, 200, {
      ok: true,
      code: decryptSecret(row.code_enc),
      pin: row.pin_enc ? decryptSecret(row.pin_enc) : null,
    });
  } catch (e) {
    console.error('[cart/gc-reveal]', e.message);
    return send(res, 500, { ok: false, error: 'Could not read that card.' });
  }
}
