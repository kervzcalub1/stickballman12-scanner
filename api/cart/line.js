// POST /api/cart/line
//   { cartId, line:{ sku, size, qty, shelfPrice, verdict, … } }  -> add
//   { cartId, lineId, patch:{ qty?, shelfPrice?, size? } }        -> edit
//   { cartId, lineId, remove:true }                               -> remove
//
// The request's contents are the BUYER'S to write, and only while it is a draft. Once
// it is submitted the list is what people are approving, so a line that could still
// change would let the contents of an approval be swapped after the fact.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  getBuyCart, getBuyCartLine, addBuyCartLine, updateBuyCartLine, removeBuyCartLine,
  priceBuyCartLine, askBuyCart, cartHasShoePhoto, cartShoePhotos, dbConfigured,
} from '../_lib/db.js';
import { notifyLineAsked } from '../_lib/notify.js';
import { cartVisibleTo, hasCostPrivilege, canSeeBuyCall, redactLineForViewer, redactCartForViewer, shelfPricesEditable, repriceLine, requireBuyerAccess } from '../_lib/buycart.js';
import { readMarketForLine } from '../_lib/lineMarket.js';

const MAX_LINES = 200;
// The buyer whose request it is. Their add is a question being asked; anybody else's is
// data entry on their behalf, and the two must not do the same thing to the status.
const isOwnBuyer = (user, cart) => user.role === 'supplier' && Number(cart.buyer_user_id) === Number(user.uid);
// `Number(null)` is 0 and `Number('')` is 0, so a blank or absent field used to store a
// hard zero — and a stored zero is a CLAIM. Every line added without a market price came
// back reading "$0.00 profit · 0.0% ROI via —", which looks like a priced pair that is
// worth nothing rather than a pair nobody has priced. Absent has to stay absent.
const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const num = (v) => { if (blank(v)) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const money = (v) => { const n = num(v); return n != null && n >= 0 ? Math.round(n * 100) / 100 : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team', 'warehouse']);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });

    // CORRECTING a line after it has been sent in is the one thing that survives the
    // draft freeze, and only for the desk. A buyer standing in a shop reads a shelf
    // ticket wrong; without this the whole request has to be pulled back and rebuilt to
    // fix one number, which in practice means it gets approved wrong instead.
    //
    // Shelf prices still freeze at `funded` — `approved_amount` is the target the gift
    // cards were issued against, and moving it after the money is out would rewrite what
    // was approved. From there the RECEIPT records what was actually paid.
    if (body.patch && cart.status !== 'draft') {
      if (!(await hasCostPrivilege(user)))
        return send(res, 403, {
          ok: false,
          error: 'This request has been sent in — only somebody who can approve or audit it can correct a line now.',
        });
      if (!shelfPricesEditable(cart))
        return send(res, 409, {
          ok: false,
          error: 'The gift cards have already been issued against these prices — record what was actually paid on the receipt instead.',
        });
    } else if (body.remove) {
      // REMOVING still needs a draft. A line somebody has already decided on is part of
      // an approval, and taking it out from under them would change what was agreed.
      if (cart.status !== 'draft')
        return send(res, 409, { ok: false, error: 'This request has been sent in — ask for it back before removing anything.' });
    } else if (!['draft', 'submitted', 'approved'].includes(cart.status)) {
      // ADDING is different, and this used to refuse it for the same reason as removing.
      // A buyer works a shop for an hour: they find a pair, ask about it, keep hunting,
      // find another. Freezing the list at the first question meant either sitting on
      // everything until the trip was over — which is when the first shoe has usually
      // gone — or opening a second request for the same run.
      //
      // A NEW line is pending and changes nothing that was already decided, so nothing
      // is at risk. It stops at `funded`: from there the approved total is what the
      // cards were issued against, and a pair added afterwards would move the target
      // the money was already released to cover.
      return send(res, 409, {
        ok: false,
        error: 'The gift cards for this request have already gone out — open a new request for anything else.',
      });
    }

    if (body.remove) {
      const gone = await removeBuyCartLine(cartId, Number(body.lineId), user);
      if (!gone) return send(res, 404, { ok: false, error: 'That line is already gone.' });
      return send(res, 200, { ok: true, removed: gone });
    }

    if (body.patch) {
      const patch = {
        qty: Number.isInteger(Number(body.patch.qty)) && Number(body.patch.qty) > 0 ? Number(body.patch.qty) : null,
        shelfPrice: blank(body.patch.shelfPrice) ? null : money(body.patch.shelfPrice),
        size: body.patch.size == null ? null : String(body.patch.size).trim().slice(0, 20) || null,
      };
      if (patch.shelfPrice != null && patch.shelfPrice <= 0)
        return send(res, 400, { ok: false, error: 'Enter the price on the shelf — it is what the gift cards have to cover.' });
      const was = await getBuyCartLine(cartId, Number(body.lineId));
      if (!was) return send(res, 404, { ok: false, error: 'That line does not exist.' });

      // What changed, in words, for the trail. A record that says "a line was edited"
      // and not what it used to say is not a record of anything.
      const bits = [];
      if (patch.size != null && String(patch.size) !== String(was.size ?? '')) bits.push(`size ${was.size || '—'} → ${patch.size}`);
      if (patch.qty != null && patch.qty !== Number(was.qty)) bits.push(`qty ${was.qty} → ${patch.qty}`);
      const shelfMoved = patch.shelfPrice != null && patch.shelfPrice !== Number(was.shelf_price);
      if (shelfMoved) bits.push(`shelf $${Number(was.shelf_price ?? 0).toFixed(2)} → $${patch.shelfPrice.toFixed(2)}`);
      // Nothing actually moved: return the line and write nothing. An "edited" row in
      // the trail that names no change is a row somebody has to open to find out it
      // says nothing, and the history is read to answer questions, not to be long.
      if (!bits.length) return send(res, 200, { ok: true, line: redactLineForViewer(was, user), unchanged: true });
      // The buy call is re-derived only when the SHELF PRICE moved, and only from the
      // market prices already captured on the line — the call still answers "at the
      // prices the buyer was looking at" (api/_lib/buycart.js repriceLine).
      const call = shelfMoved ? repriceLine({ ...was, shelf_price: patch.shelfPrice }, cart.cost_stack || {}) : null;

      const line = await updateBuyCartLine(cartId, Number(body.lineId), patch, user, call,
        `${was.sku}${was.size ? ` size ${was.size}` : ''}${bits.length ? ` — ${bits.join(', ')}` : ''}`);
      if (!line) return send(res, 404, { ok: false, error: 'That line does not exist.' });
      return send(res, 200, { ok: true, line: redactLineForViewer(line, user) });
    }

    if (Number(cart.line_count) >= MAX_LINES)
      return send(res, 409, { ok: false, error: `A request holds at most ${MAX_LINES} lines.` });

    const l = body.line || {};
    const sku = String(l.sku ?? '').trim().toUpperCase().slice(0, 40);
    // NO QUANTITY. The buyer reports what they found in a shop — this shoe, this size,
    // this price on the ticket — and how many to buy is the decision being asked for, so
    // it belongs to whoever approves it (`cart/decide`). Defaulting to 1 here would put
    // a number nobody stated into the funding total.
    const qty = null;
    const shelfPrice = money(l.shelfPrice);
    if (!sku) return send(res, 400, { ok: false, error: 'A SKU is required.' });
    // The shelf price is the funding target for this line. Without it a request can be
    // approved for an amount nobody can compute, so it is required rather than defaulted
    // to zero — a $0 pair would silently fund nothing.
    if (shelfPrice == null || shelfPrice <= 0)
      return send(res, 400, { ok: false, error: 'Enter the price on the shelf — it is what the gift cards have to cover.' });

    const size = String(l.size ?? '').trim().slice(0, 20) || null;
    const upc = String(l.upc ?? '').replace(/\D/g, '').slice(0, 20) || null;
    const basis = l.basis === 'consigned' ? 'consigned' : 'with_you';

    // WHERE THE CALL COMES FROM depends on who is adding.
    //
    // Staff post the snapshot their own screen derived — the calculator is the only
    // place those numbers are worked out, so a second code path here could disagree
    // with it about the same pair.
    //
    // A BUYER posts nothing that is believed. Their screen no longer computes a call at
    // all (the call is the approver's — `canSeeBuyCall`), and even if it did, taking it
    // on trust would mean the party asking for the money supplies the figures that
    // justify releasing it: a crafted request could arrive reading "buy, $180 profit"
    // with no market behind it. So the market is read HERE, once, and the call derived
    // from our own cost stack.
    let call = null;
    // Set when the market still has to be read — see `priceInBackground` below.
    let toPrice = false;
    if (!canSeeBuyCall(user)) {
      // The pair still LANDS AT something without any market at all: `final_cost` is
      // the buyer's own shelf price run through the cost stack, and it is not part of
      // the call (it is theirs to see). Computed here so the column is true instantly.
      call = repriceLine({ shelf_price: shelfPrice, alias_price: null, stockx_price: null, liquidity: null },
        cart.cost_stack || {});
      toPrice = !!size;
    } else {
      call = {
        verdict: ['buy', 'watch', 'pass'].includes(l.verdict) ? l.verdict : null,
        finalCost: money(l.finalCost),
        bestPlatform: String(l.bestPlatform ?? '').slice(0, 20) || null,
        bestPayout: money(l.bestPayout), profit: num(l.profit), roi: num(l.roi),
        aliasPrice: money(l.aliasPrice), stockxPrice: money(l.stockxPrice),
        liquidity: String(l.liquidity ?? '').slice(0, 20) || null,
      };
    }

    // A photo of the shoe is what the approver decides on — they are not in the shop and
    // the style code is four characters from a different pair. Checked HERE now rather
    // than only at submit, because for a buyer the add IS the submit.
    if (isOwnBuyer(user, cart) && !(await cartHasShoePhoto(cartId, sku)))
      return send(res, 400, {
        ok: false,
        error: `Add a photo of ${sku} first — the desk decides on it and cannot see the shoe. One photo covers every size of it.`,
      });

    const line = await addBuyCartLine(cartId, {
      sku, size, qty, shelfPrice, upc,
      name: String(l.name ?? '').trim().slice(0, 200) || null,
      colorway: String(l.colorway ?? '').trim().slice(0, 120) || null,
      gender: String(l.gender ?? '').trim().slice(0, 20) || null,
      // Absent stays absent: `Number(null)` is 0 and a stored zero is a CLAIM — every
      // unpriced line once read "$0.00 profit · 0.0% ROI via —", which looks like a
      // priced pair that is worth nothing rather than a pair nobody has priced.
      verdict: call?.verdict ?? null,
      finalCost: call?.finalCost ?? null,
      bestPlatform: call?.bestPlatform ?? null,
      bestPayout: call?.bestPayout ?? null,
      profit: call?.profit ?? null,
      roi: call?.roi ?? null,
      aliasPrice: call?.aliasPrice ?? null,
      stockxPrice: call?.stockxPrice ?? null,
      liquidity: call?.liquidity ?? null,
      basis,
    }, user);
    // AFTER the response, never before it. The buyer is standing in a shop with a shoe
    // in one hand and a phone in the other, and Alias runs 16s on an ordinary day and
    // 20–45s on a bad one — measured. Pricing inline made "Add to request" hang for all
    // of it, which is the difference between a tool you use on a shop floor and one you
    // stop using. Nothing is lost by deferring it: the buyer is not allowed to see the
    // call anyway, and the approver reads the line minutes or hours later.
    //
    // If it fails, the line simply stays unpriced — an ordinary state with a way back
    // (the desk's "Price it"), and the same state a timed-out quote has always left.
    // Tell Make AFTER the market read, not with the add — a card that goes out first
    // says "not priced" on every pair, which is the one thing the approver most needs.
    // Both paths are fire-and-forget: the buyer is in a shop and must never wait on
    // either of them. `photos` is read now because the file rows are already there.
    const asking = isOwnBuyer(user, cart);
    const photos = asking ? await cartShoePhotos(cartId, sku) : [];
    if (toPrice) {
      priceInBackground(cartId, Number(line.id), { sku, size, upc, basis, shelfPrice }, cart.cost_stack || {}, {
        notify: asking, photos,
      });
    } else if (asking) {
      notifyLineAsked(cartId, Number(line.id), { photoFileId: photos[0] ?? null, photoCount: photos.length });
    }
    // ADDING A PAIR *IS* ASKING ABOUT IT. There is no separate "send for approval" for a
    // buyer any more: they are standing in a shop and the desk should be able to answer
    // while the shoe is still on the shelf. A trip that ends with the buyer remembering
    // to press Send is a trip where the first pair sat unasked for an hour.
    //
    // Only for the BUYER. A desk adding a line on somebody's behalf is data entry, not a
    // question being asked, and flipping the request's state under them would be a
    // surprise. Their add leaves the status exactly as it was.
    const asked = isOwnBuyer(user, cart) ? await askBuyCart(cartId, user) : null;
    // The line goes back to whoever added it as THEY may see it — a buyer's copy has
    // never carried a call, and must not start carrying one on the way out of the add.
    return send(res, 200, {
      ok: true,
      line: redactLineForViewer(line, user),
      ...(asked ? { cart: redactCartForViewer(asked, user) } : {}),
    });
  } catch (e) {
    console.error('[cart/line]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the request.' });
  }
}

/**
 * Read the market for a line that has just been added, and write the call onto it.
 *
 * Deliberately not awaited by the handler. This runs in a long-lived Express process,
 * so there is somewhere for it to finish; the worst case is a redeploy landing mid-read,
 * which leaves the line unpriced — indistinguishable from an Alias timeout, and fixed
 * the same way.
 *
 * Logged with NO actor, so the trail reads as system-generated rather than crediting
 * the buyer with a call they are not allowed to see or make.
 */
async function priceInBackground(cartId, lineId, { sku, size, upc, basis, shelfPrice }, stack, tell = null) {
  try {
    const m = await readMarketForLine({ sku, size, upc, consigned: basis === 'consigned' });
    // Nothing answered. Leave the row alone rather than stamping two zeros on it — a
    // stored zero reads as "priced, and worthless".
    if (!m.priced) return;
    const snap = {
      ...repriceLine({
        shelf_price: shelfPrice,
        alias_price: m.aliasPrice, stockx_price: m.stockxPrice, liquidity: m.liquidity,
      }, stack),
      aliasPrice: m.aliasPrice, stockxPrice: m.stockxPrice, liquidity: m.liquidity,
    };
    if (!snap.finalCost) return;
    await priceBuyCartLine(cartId, lineId, snap, null,
      `${sku}${size ? ` size ${size}` : ''} — priced on arrival: Alias ${m.aliasPrice == null ? '—' : `$${m.aliasPrice.toFixed(2)}`}`
      + ` · StockX ${m.stockxPrice == null ? '—' : `$${m.stockxPrice.toFixed(2)}`}`
      + ` → ${snap.verdict || 'no call'}`);
  } catch (e) {
    console.error('[cart/line] background pricing failed, line stays unpriced:', e.message);
  }
  // Whatever happened above — priced, unpriced, or upstream down — the desk still has to
  // be told the pair was asked about. A market outage must not swallow the question.
  // WHETHER WE EVEN TRY is the other half of "no card arrived". A line the buyer added
  // that was never treated as a question leaves no trace at all otherwise.
  if (!tell?.notify) console.log(`[cart/line] line ${lineId} priced — no card (not the buyer's own ask)`);
  if (tell?.notify) {
    await notifyLineAsked(cartId, lineId, {
      photoFileId: tell.photos?.[0] ?? null,
      photoCount: tell.photos?.length ?? 0,
    });
  }
}
