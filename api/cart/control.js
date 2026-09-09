// POST /api/cart/control  { cartId, funding:{ method, cardReference, cardAuthorized } }
// POST /api/cart/control  { cartId, custody:{ holder, holderLocation, shipBy } }
//
// The two facts about a request that were nowhere: HOW the money left, and WHO is
// holding the shoes until the courier takes them.
//
// **Funding.** Company funds go out by two routes — a gift card, or a charge on a
// company card — and everything here was keyed on the card total, so a card-funded
// purchase read as unfunded forever and could never be closed. Recording the route also
// changes what the closing conditions ask: cards are objects with balances, a charge is
// a reference on a statement, and asking either question of the other proves nothing.
//
// **Custody.** Between the till and the courier the pairs are company inventory sitting
// in somebody's flat, invisible to everyone. A holder, a location and a ship-by date is
// the smallest thing that makes that visible — and the ship-by is what turns "he still
// hasn't sent it" from a memory into a date somebody can be asked about.
//
// The route is frozen once money has actually moved: re-labelling a funded request as
// card-funded would silently re-point every condition at evidence that does not exist.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import {
  getBuyCart, getBuyCartFull, setCartFunding, setCartCustody, fundBuyCart, dbConfigured,
} from '../_lib/db.js';
import { requirePrivilege, cartCloseChecks } from '../_lib/buycart.js';

const text = (v, n = 200) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '').trim()) ? String(v).trim() : null);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  const user = await requirePrivilege(req, res, 'approve_buying',
    'Only a buying desk can set how a request is funded or who is holding it.');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (['closed', 'cancelled', 'written_off'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'This request is finished.' });

    if (body.funding) {
      const method = body.funding.method === 'company_card' ? 'company_card' : 'gift_card';
      // Once cards exist or a receipt is in, the route is a matter of record rather than
      // a setting. Changing it then would re-point the closing conditions at evidence
      // nobody ever gathered.
      const moved = Number(cart.gc_total) > 0 || cart.receipt_total != null;
      if (moved && method !== (cart.funding_method || 'gift_card'))
        return send(res, 409, { ok: false, error: 'Money has already moved on this request — the funding route can’t be changed now.' });
      const cardReference = method === 'company_card' ? text(body.funding.cardReference, 80) : null;
      const cardAuthorized = method === 'company_card' ? money(body.funding.cardAuthorized) : null;
      if (method === 'company_card' && !cardReference)
        return send(res, 400, { ok: false, error: 'A card charge needs a payment reference — one that traces back to a statement line.' });
      await setCartFunding({ cartId, method, cardReference, cardAuthorized, actor: user });

      // RECORDING THE CHARGE IS THE RELEASE. A gift-card request reaches `funded` when
      // the desk hands the cards over; a card-funded one has no cards to hand over, so
      // without this it stayed at `approved` forever — and every downstream step is
      // gated on `funded`, so the receipt could never be uploaded, read, or reconciled.
      // The whole route was a dead end from the step after this one.
      if (method === 'company_card' && cardReference && cardAuthorized > 0 && cart.status === 'approved')
        await fundBuyCart(cartId, user,
          `Company card authorised for $${cardAuthorized.toFixed(2)} · ref ${cardReference}`);
    }

    if (body.custody) {
      const shipBy = date(body.custody.shipBy);
      if (body.custody.shipBy && !shipBy)
        return send(res, 400, { ok: false, error: 'A ship-by date has to be a calendar day (YYYY-MM-DD).' });
      await setCartCustody({
        cartId,
        holder: text(body.custody.holder, 120),
        holderLocation: text(body.custody.holderLocation, 200),
        shipBy,
        actor: user,
      });
    }

    if (!body.funding && !body.custody)
      return send(res, 400, { ok: false, error: 'Nothing to change.' });

    const full = await getBuyCartFull(cartId);
    return send(res, 200, { ok: true, cart: full, checks: await cartCloseChecks(full) });
  } catch (e) {
    console.error('[cart/control]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save that.' });
  }
}
