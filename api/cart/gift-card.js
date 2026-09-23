// POST /api/cart/gift-card
//   { cartId, card:{ code, pin?, balance, retailer?, label? } }  -> record a card
//   { cartId, voidId, reason? }                                  -> void one
//   { cartId, fund:true }                                        -> release the request
//
// Step 3, and the one endpoint in this app that handles money in the hand.
//
// A card code plus its PIN is a bearer instrument: whoever reads it can spend it. So it
// is encrypted before it reaches the query layer (api/_lib/secrets.js), only the last
// four are ever returned, and this handler holds the plaintext for the length of one
// request and never logs it. `secretsConfigured()` is checked FIRST and fails the write
// — storing the codes in the clear because an env var wasn't set is precisely the
// outcome the encryption is there to prevent, and it would be invisible until it
// mattered.
//
// Cards can only go against an APPROVED request whose buyer has CLOSED THE LIST. That
// is the process's first rule stated as code: no known purchase and no approval means
// no gift cards — and a list the buyer is still adding to is not yet a known purchase.
// A re-opened, funded request takes a top-up card once its new lines are approved and
// the list is closed again; the cards already issued are never touched.
//
// Recording stays open past the till — `receipted` and `audited` — for the card the
// buyer spent that nobody recorded (the receipt came to more than the cards on file).
// It lands with no spend, so the money audit has to be recorded again with it in.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import {
  getBuyCart, addBuyCartGiftCard, voidBuyCartGiftCard, fundBuyCart, dbConfigured,
} from '../_lib/db.js';
import { encryptSecret, maskTail, secretsConfigured } from '../_lib/secrets.js';
import { requirePrivilege, fundingTarget, fundingTaxPct, redactCartForViewer } from '../_lib/buycart.js';
import { cardsIssuable, cardsRefusedBecause } from '../../src/lib/buycartRules.js';

const money = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'issue_gift_cards'); // admin/superadmin implicit
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });

    if (body.voidId != null) {
      if (cart.status === 'closed') return send(res, 409, { ok: false, error: 'This request is closed.' });
      const gone = await voidBuyCartGiftCard({
        cartId, gcId: Number(body.voidId),
        reason: String(body.reason ?? '').trim().slice(0, 300) || null, actor: user,
      });
      if (!gone) return send(res, 404, { ok: false, error: 'That card is already voided or gone.' });
      return send(res, 200, { ok: true, voided: gone });
    }

    if (body.fund) {
      if (cart.status !== 'approved')
        return send(res, 409, { ok: false, error: 'Only an approved request can be released.' });
      if (!cardsIssuable(cart))
        return send(res, 409, { ok: false, error: cardsRefusedBecause(cart) });
      const target = fundingTarget(cart);
      // The check the whole step turns on: the cards have to cover what was approved,
      // tax included. Named with the shortfall, because "not enough" without a number
      // sends somebody back to a spreadsheet to work out what to add.
      if (Number(cart.gc_total) < target) {
        return send(res, 409, {
          ok: false,
          error: `The cards total $${Number(cart.gc_total).toFixed(2)} against $${target.toFixed(2)} to fund ($${Number(cart.approved_amount).toFixed(2)} approved${fundingTaxPct(cart) ? ` + ${fundingTaxPct(cart)}% tax` : ''}) — $${(target - Number(cart.gc_total)).toFixed(2)} short. Add another card first.`,
        });
      }
      const out = await fundBuyCart(cartId, user);
      if (!out) return send(res, 409, { ok: false, error: 'This request has already been released.' });
      return send(res, 200, { ok: true, cart: redactCartForViewer(out, user) });
    }

    // ---- record a card -----------------------------------------------------
    if (!cardsIssuable(cart)) return send(res, 409, { ok: false, error: cardsRefusedBecause(cart) });
    if (!secretsConfigured()) {
      return send(res, 503, {
        ok: false,
        error: 'Gift card codes can’t be stored securely on this server yet (BUY_GC_KEY is not set). Upload a photo of the card instead, or ask an admin to set the key.',
      });
    }

    const c = body.card || {};
    const code = String(c.code ?? '').trim().slice(0, 120);
    const pin = String(c.pin ?? '').trim().slice(0, 40);
    const balance = money(c.balance);
    if (!code) return send(res, 400, { ok: false, error: 'Enter the gift card number.' });
    if (balance == null) return send(res, 400, { ok: false, error: 'Enter what is on the card.' });

    const card = await addBuyCartGiftCard({
      cartId,
      codeEnc: encryptSecret(code),
      codeLast4: maskTail(code),
      pinEnc: pin ? encryptSecret(pin) : null,
      balance,
      retailer: String(c.retailer ?? cart.retailer ?? '').trim().slice(0, 120) || null,
      label: String(c.label ?? '').trim().slice(0, 120) || null,
      actor: user,
    });
    const after = await getBuyCart(cartId);
    return send(res, 200, {
      ok: true, card,
      gcTotal: Number(after.gc_total), target: fundingTarget(after),
      short: Math.max(0, Math.round((fundingTarget(after) - Number(after.gc_total)) * 100) / 100),
    });
  } catch (e) {
    if (e.notConfigured) return send(res, 503, { ok: false, error: e.message });
    // Never let a driver error carry the code into the log: report the shape of the
    // failure, not the statement that failed.
    console.error('[cart/gift-card]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record that gift card.' });
  }
}
