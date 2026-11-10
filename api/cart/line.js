// POST /api/cart/line
//   { cartId, line:{ sku, size, availableQty, shelfPrice, verdict, … } }  -> add
//   { cartId, lines:[ …same, every size of ONE sku… ] }           -> add several, ONE card
//   { cartId, lineId, patch:{ qty?, availableQty?, shelfPrice?, size?, fullBox?, premium?, tipProposed? } }  -> edit
//   { cartId, lineId, remove:true }                               -> remove
//   { cartId, lineId, skip:true|false }                           -> not buying it / back on
//   { cartId, lineId, more:n, size?, shelfPrice? }                -> the buyer found n more (of this size, or another size of the shoe)
//
// The request's LIST is the buyer's to grow until they close it (`list_closed_at`) —
// every add is its own question to the desk, and a request with cards already out can
// be re-opened for more. What the buyer can never do is change a line somebody has
// decided on: a decided line is part of an approval, and removing or editing it would
// swap the contents of that approval after the fact.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  getBuyCart, getBuyCartLine, addBuyCartLine, updateBuyCartLine, removeBuyCartLine,
  priceBuyCartLine, askBuyCart, cartHasShoePhoto, cartShoePhotos, dbConfigured,
  setBuyCartLineSales, skipBuyCartLine, getBuyCartLinesForSku,
} from '../_lib/db.js';
import { notifyLineAsked, notifyGroupAsked, notifyLineSkipped, notifyIssuersIfReady } from '../_lib/notify.js';
import { cartVisibleTo, hasCostPrivilege, canSeeBuyCall, redactLineForViewer, redactCartForViewer, shelfPricesEditable, repriceLine, requireBuyerAccess } from '../_lib/buycart.js';
import { buyerCanAdd, listOpen, LIST_ADDABLE } from '../../src/lib/buycartRules.js';
import { readMarketForLine } from '../_lib/lineMarket.js';
import { readMarketSales } from '../_lib/marketSales.js';
import { sizeKey } from '../../src/lib/buyPaste.js';

const MAX_LINES = 200;
const NEEDS_SIZE = 'Pick a size. The price, payout and profit all depend on it.';
// A typed "n/a" or "-" is still no size. It has to hold a letter or digit and not be a stand-in.
const isRealSize = (s) => !!s && /[0-9a-z]/i.test(s) && !/^(n\/?a|none|no ?size|unknown|tbd)$/i.test(s.trim());

// One shoe's sizes in one ask — a full run in halves is ~30; past that it is two shoes.
const MAX_GROUP = 40;
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
    // THE BUYER fixes their OWN pair after sending it (floor feedback, 2026-11-02): a
    // misread ticket, the wrong size tapped, a count, full box, premium + tip. Only while
    // the pair is still PENDING — nobody has answered it — checked again in the write
    // itself (`onlyIfPending`) so a desk deciding it in the same second wins. Never the
    // quantity: how many to buy is the approver's answer, not the buyer's question.
    const buyerFix = !!body.patch && isOwnBuyer(user, cart);
    if (buyerFix) {
      if (!LIST_ADDABLE.includes(cart.status))
        return send(res, 409, { ok: false, error: 'This request is past the point of changing a pair — the purchase has happened.' });
    } else if (body.skip !== undefined) {
      // NOT BUYING IT ("X out"). The buyer, standing in the shop, isn't grabbing a pair
      // that was approved — so the cards shouldn't be sized for it. A desk may do it for
      // them (they said so in the chat). Before any card is recorded: after that the
      // receipt says what was bought and the audit returns the rest (skipBuyCartLine).
      if (!isOwnBuyer(user, cart) && !(await hasCostPrivilege(user)))
        return send(res, 403, { ok: false, error: 'Only the buyer or a buying desk can mark a pair as not being bought.' });
    } else if (body.patch && cart.status !== 'draft') {
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
      // REMOVING is allowed only while the line is still a QUESTION. A line somebody has
      // already decided on is part of an approval, and taking it out from under them
      // would change what was agreed. A pending one is the buyer's to withdraw while
      // their list is open (they asked, nobody has answered, they changed their mind),
      // and the desk's to remove on a draft as before.
      const was = await getBuyCartLine(cartId, Number(body.lineId));
      if (!was) return send(res, 404, { ok: false, error: 'That line is already gone.' });
      if (was.status !== 'pending')
        return send(res, 409, { ok: false, error: `${was.sku}${was.size ? ` size ${was.size}` : ''} has already been ${was.status} — it is part of a decision now and can’t be removed.` });
      const mayRemove = cart.status === 'draft'
        || (isOwnBuyer(user, cart) && listOpen(cart) && buyerCanAdd(cart))
        || (!isOwnBuyer(user, cart) && await hasCostPrivilege(user));
      if (!mayRemove)
        return send(res, 409, {
          ok: false,
          error: isOwnBuyer(user, cart) && cart.list_closed_at
            ? 'You closed this request — re-open it before removing anything.'
            : 'Only the buyer (while the request is open) or a buying desk can remove a line.',
        });
    } else if (!buyerCanAdd(cart)) {
      // ADDING is allowed for as long as the buyer's LIST IS OPEN. A buyer works a shop
      // for an hour: they find a pair, ask about it, keep hunting, find another. Each
      // add is a question in its own right and changes nothing already decided.
      //
      // It no longer stops at `funded` either: a buyer who finds the cards short, or one
      // more pair on the way out, re-opens the list and adds. The approvals the money
      // went out against are frozen (decisions become pending-only); the new lines,
      // once approved, raise the target and the desk records a top-up. What ends it is
      // the RECEIPT — from there the purchase has happened.
      return send(res, 409, {
        ok: false,
        error: cart.list_closed_at && ['submitted', 'approved', 'denied', 'funded'].includes(cart.status)
          ? (isOwnBuyer(user, cart)
            ? 'You closed this request — re-open it to add more.'
            : 'The buyer has closed this request — they can re-open it to add more.')
          : 'This request is past the point of adding to it — open a new request for anything else.',
      });
    }

    // THE BUYER FOUND MORE of a pair they already sent. An unanswered pair's shelf count goes up.
    // An approved pair stays exactly as approved (the money may be out against it), so the extra
    // is a new question beside it. Either way the group gets a card and the approver decides.
    //
    // OF A DIFFERENT SIZE too (Andrew, 2026-11-10): `size` names another size of the same
    // shoe. If that size is already on the request, it's handled exactly as if the buyer had
    // tapped Found more on that size's own row. If it isn't, it's a new pending line, priced
    // and carded like any ask, with the shoe's details (photo, premium, tip, full box) and the
    // shelf price carried over unless `shelfPrice` says otherwise. Never the UPC, which is per size.
    if (body.more !== undefined) {
      if (!isOwnBuyer(user, cart))
        return send(res, 403, { ok: false, error: 'Only the buyer who sent this pair can add more of it.' });
      const more = Number(body.more);
      if (!Number.isInteger(more) || more < 1 || more > 999)
        return send(res, 400, { ok: false, error: 'Say how many more you found, from 1 to 999.' });
      const source = await getBuyCartLine(cartId, Number(body.lineId));
      if (!source) return send(res, 404, { ok: false, error: 'That pair is no longer on the request.' });
      const sentSize = body.size == null ? '' : String(body.size).trim().slice(0, 20);
      const otherSize = !!sentSize && sizeKey(sentSize) !== sizeKey(source.size);
      if (otherSize && !isRealSize(sentSize)) return send(res, 400, { ok: false, error: NEEDS_SIZE });
      const who = user.name || user.username;
      const photos = await cartShoePhotos(cartId, source.sku);

      // The line the extra pairs are added to: this row, or the row already holding that size
      // (an unanswered one first, else the latest approved, else whatever it last was).
      let was = source;
      if (otherSize) {
        const same = (await getBuyCartLinesForSku(cartId, source.sku)).filter((l) => sizeKey(l.size) === sizeKey(sentSize));
        was = same.find((l) => l.status === 'pending')
          || [...same].reverse().find((l) => l.status === 'approved')
          || same[same.length - 1] || null;
      }

      if (!was) {
        // A size that isn't on the request yet: a fresh ask.
        if (Number(cart.line_count) + 1 > MAX_LINES)
          return send(res, 409, { ok: false, error: `A request holds at most ${MAX_LINES} lines.` });
        if (!photos.length)
          return send(res, 400, { ok: false, error: `Add a photo of ${source.sku} first — the desk decides on it and cannot see the shoe.` });
        const p = prepareLine({
          sku: source.sku, size: sentSize, availableQty: more,
          shelfPrice: blank(body.shelfPrice) ? source.shelf_price : body.shelfPrice,
          premium: !!source.premium, tipProposed: source.tip_proposed, fullBox: !!source.full_box,
          name: source.name, colorway: source.colorway, gender: source.gender, basis: source.basis,
        }, user, cart);
        if (p.error) return send(res, 400, { ok: false, error: p.error });
        const line = await addBuyCartLine(cartId, p.row, user);
        priceInBackground(cartId, Number(line.id), { ...p.market }, cart.cost_stack || {}, {
          notify: true, photos,
          edited: `➕ FOUND MORE, ${who}: a new size of this shoe, size ${p.row.size} (${more} in the shop).`,
        });
        const asked = await askBuyCart(cartId, user);
        return send(res, 200, { ok: true, line: redactLineForViewer(line, user), ...(asked ? { cart: redactCartForViewer(asked, user) } : {}) });
      }

      const lineId = Number(was.id);
      const pair = `${was.sku}${was.size ? ` size ${was.size}` : ''}`;
      if (was.status === 'pending') {
        const count = Math.min((Number(was.available_qty) || 0) + more, 999);
        const change = `in store ${was.available_qty ?? 'not counted'} → ${count}`;
        const line = await updateBuyCartLine(cartId, lineId, { availableQty: count }, user, null,
          `${pair} — found ${more} more, ${change}`, { onlyIfPending: true });
        if (line) {
          notifyLineAsked(cartId, lineId, { photoFileId: photos[0] ?? null, photoCount: photos.length,
            edited: `➕ FOUND MORE, ${who}: ${otherSize ? `size ${was.size}, ` : ''}${change}` });
          return send(res, 200, { ok: true, line: redactLineForViewer(line, user) });
        }
        // The desk answered it in the same second, so it is read again and handled as answered.
        was = await getBuyCartLine(cartId, lineId);
      }
      if (was?.status !== 'approved')
        return send(res, 409, { ok: false, error: `${pair} ${was?.status === 'skipped' ? 'is marked as not buying' : 'was turned down'}, so there is nothing to add to. Add it as a new pair to ask again.` });
      if (Number(cart.line_count) + 1 > MAX_LINES)
        return send(res, 409, { ok: false, error: `A request holds at most ${MAX_LINES} lines.` });
      if (!photos.length)
        return send(res, 400, { ok: false, error: `Add a photo of ${was.sku} first — the desk decides on it and cannot see the shoe.` });
      const p = prepareLine({
        sku: was.sku, size: was.size, availableQty: more, shelfPrice: was.shelf_price, upc: was.upc,
        premium: !!was.premium, tipProposed: was.tip_proposed, fullBox: !!was.full_box,
        name: was.name, colorway: was.colorway, gender: was.gender, basis: was.basis,
      }, user, cart);
      if (p.error) return send(res, 400, { ok: false, error: p.error });
      const line = await addBuyCartLine(cartId, p.row, user);
      priceInBackground(cartId, Number(line.id), { ...p.market }, cart.cost_stack || {}, {
        notify: true, photos,
        edited: `➕ FOUND MORE, ${who}: ${more} more of size ${was.size}. Already approved ×${was.qty}${was.decided_by ? ` by ${was.decided_by}` : ''}, and that stands.`,
      });
      const asked = await askBuyCart(cartId, user);
      return send(res, 200, { ok: true, line: redactLineForViewer(line, user), ...(asked ? { cart: redactCartForViewer(asked, user) } : {}) });
    }

    if (body.skip !== undefined) {
      const undo = body.skip === false;
      const lineId = Number(body.lineId);
      const out = await skipBuyCartLine(cartId, lineId, user, { undo });
      if (!out) {
        // Say WHICH of the three it was — they lead to different next steps.
        const was = await getBuyCartLine(cartId, lineId);
        const name = was ? `${was.sku}${was.size ? ` size ${was.size}` : ''}` : 'That pair';
        if (!was) return send(res, 404, { ok: false, error: 'That pair is no longer on the request.' });
        if (!undo && was.status !== 'approved')
          return send(res, 409, { ok: false, error: was.status === 'pending'
            ? `${name} hasn’t been answered yet — remove it with × instead.`
            : `${name} is ${was.status === 'skipped' ? 'already marked as not buying' : 'turned down'} — there is nothing to X out.` });
        if (undo && was.status !== 'skipped')
          return send(res, 409, { ok: false, error: `${name} isn’t marked as not buying.` });
        return send(res, 409, { ok: false, error: 'The gift cards are already out against this request — tell the desk, and the receipt shows what was actually bought.' });
      }
      notifyLineSkipped(cartId, out.line, user, { undo });
      notifyIssuersIfReady(cartId);   // the amount to fund just changed
      return send(res, 200, { ok: true, line: redactLineForViewer(out.line, user), cart: redactCartForViewer(out.cart, user) });
    }

    if (body.remove) {
      const gone = await removeBuyCartLine(cartId, Number(body.lineId), user);
      if (!gone) return send(res, 404, { ok: false, error: 'That line is already gone.' });
      return send(res, 200, { ok: true, removed: gone });
    }

    if (body.patch) {
      // An explicit empty string is how the in-store count gets UNSET — the buyer
      // guessed and would rather say nothing than say a number. Absent (undefined) still
      // means "leave it alone", which is what every other field here means by null.
      const availSent = body.patch.availableQty;
      const bool = (v) => (v === true || v === false ? v : null);
      const patch = {
        // The quantity is the approver's answer; a buyer's is ignored, never stored.
        qty: !buyerFix && Number.isInteger(Number(body.patch.qty)) && Number(body.patch.qty) > 0 ? Number(body.patch.qty) : null,
        availableQty: Number.isInteger(Number(availSent)) && Number(availSent) > 0 ? Math.min(Number(availSent), 999) : null,
        clearAvailable: availSent === '' || availSent === null,
        shelfPrice: blank(body.patch.shelfPrice) ? null : money(body.patch.shelfPrice),
        // Blank leaves the size alone, like every other field here, so an edit can't clear it.
        size: body.patch.size == null ? null : String(body.patch.size).trim().slice(0, 20) || null,
        fullBox: bool(body.patch.fullBox),
        // Premium + its tip are the BUYER's proposal; the desk answers a tip on cart/tip.
        premium: buyerFix ? bool(body.patch.premium) : null,
      };
      if (patch.size != null && !isRealSize(patch.size))
        return send(res, 400, { ok: false, error: NEEDS_SIZE });
      if (patch.shelfPrice != null && patch.shelfPrice <= 0)
        return send(res, 400, { ok: false, error: 'Enter the price on the shelf — it is what the gift cards have to cover.' });
      const was = await getBuyCartLine(cartId, Number(body.lineId));
      if (!was) return send(res, 404, { ok: false, error: 'That line does not exist.' });
      if (buyerFix && was.status !== 'pending')
        return send(res, 409, { ok: false, error: `${was.sku}${was.size ? ` size ${was.size}` : ''} has already been ${was.status === 'skipped' ? 'marked as not buying' : was.status} — ask the desk to change it.` });

      // THE TIP, when the buyer touched premium or the tip box. Not premium → no tip; a
      // blank box on a premium shoe → no tip proposed (the desk decides), never $0.
      if (buyerFix && (patch.premium != null || body.patch.tipProposed !== undefined)) {
        const premiumNow = patch.premium ?? !!was.premium;
        const tipSent = body.patch.tipProposed;
        const tip = premiumNow && !blank(tipSent) ? money(tipSent) : null;
        if (premiumNow && !blank(tipSent) && !(tip > 0))
          return send(res, 400, { ok: false, error: 'Enter the tip you are proposing per pair, or leave it blank.' });
        if (tip != null && tip > 500)
          return send(res, 400, { ok: false, error: 'A tip above $500 a pair can’t be right — check the amount.' });
        const tipBefore = was.tip_proposed == null ? null : Number(was.tip_proposed);
        if (tip !== tipBefore || (!premiumNow && was.tip_status != null)) { patch.tipTouched = true; patch.tipProposed = tip; }
      }

      // What changed, in words, for the trail. A record that says "a line was edited"
      // and not what it used to say is not a record of anything.
      const bits = [];
      if (patch.size != null && String(patch.size) !== String(was.size ?? '')) bits.push(`size ${was.size || '—'} → ${patch.size}`);
      if (patch.qty != null && patch.qty !== Number(was.qty)) bits.push(`qty ${was.qty} → ${patch.qty}`);
      if (patch.clearAvailable && was.available_qty != null) bits.push(`in store ${was.available_qty} → not counted`);
      else if (patch.availableQty != null && patch.availableQty !== was.available_qty) bits.push(`in store ${was.available_qty ?? 'not counted'} → ${patch.availableQty}`);
      const shelfMoved = patch.shelfPrice != null && patch.shelfPrice !== Number(was.shelf_price);
      if (shelfMoved) bits.push(`shelf $${Number(was.shelf_price ?? 0).toFixed(2)} → $${patch.shelfPrice.toFixed(2)}`);
      if (patch.fullBox != null && patch.fullBox !== !!was.full_box) bits.push(patch.fullBox ? 'full box' : 'not full box');
      if (patch.premium != null && patch.premium !== !!was.premium) bits.push(patch.premium ? 'premium' : 'not premium');
      if (patch.tipTouched) bits.push(patch.tipProposed != null ? `tip proposed $${patch.tipProposed.toFixed(2)}/pair` : 'no tip proposed');
      // Nothing actually moved: return the line and write nothing. An "edited" row in
      // the trail that names no change is a row somebody has to open to find out it
      // says nothing, and the history is read to answer questions, not to be long.
      if (!bits.length) return send(res, 200, { ok: true, line: redactLineForViewer(was, user), unchanged: true });
      const sizeMoved = patch.size != null && String(patch.size) !== String(was.size ?? '');
      // The buy call is re-derived when the SHELF PRICE or the TIP moved, from the market
      // prices already captured on the line — the call still answers "at the prices the
      // buyer was looking at" (api/_lib/buycart.js repriceLine). A buyer's new SIZE is a
      // different market: it is re-read below, after the response.
      const call = shelfMoved || patch.tipTouched
        ? repriceLine({
          ...was,
          shelf_price: patch.shelfPrice ?? was.shelf_price,
          ...(patch.tipTouched ? { tip_proposed: patch.tipProposed, tip_status: patch.tipProposed != null ? 'proposed' : null, tip_approved: null } : {}),
        }, cart.cost_stack || {})
        : null;

      const changed = `${was.sku}${was.size ? ` size ${was.size}` : ''} — ${bits.join(', ')}`;
      const line = await updateBuyCartLine(cartId, Number(body.lineId), patch, user, call, changed,
        { onlyIfPending: buyerFix });
      if (!line)
        return send(res, buyerFix ? 409 : 404, { ok: false, error: buyerFix
          ? 'The desk answered this pair while you were editing it — nothing was changed. Ask them to change it.'
          : 'That line does not exist.' });

      // The group decides from the CARD, and the card still quotes the old numbers. A
      // buyer's change re-posts the pair as a fresh card headed by what changed; a new
      // size is priced first (and its sales read) so the card carries the right call.
      if (buyerFix && cart.status !== 'draft') {
        const photos = await cartShoePhotos(cartId, line.sku);
        const tell = { notify: true, photos, edited: `✏️ CHANGED by ${user.name || user.username}: ${bits.join(', ')}` };
        if (sizeMoved && line.size) {
          priceInBackground(cartId, Number(line.id), {
            sku: line.sku, size: line.size, upc: line.upc, basis: line.basis,
            shelfPrice: Number(line.shelf_price), tipProposed: line.tip_proposed,
          }, cart.cost_stack || {}, tell);
        } else {
          notifyLineAsked(cartId, Number(line.id), { photoFileId: photos[0] ?? null, photoCount: photos.length, edited: tell.edited });
        }
      }
      return send(res, 200, { ok: true, line: redactLineForViewer(line, user) });
    }

    // SEVERAL SIZES OF ONE SHOE in one call (`lines`), or one line (`line`). The sizes
    // go in as one line each, exactly as before; what the batch changes is the CARD —
    // one per shoe, answered by a "size x qty" reply (notifyGroupAsked) instead of one
    // per size. Every line is checked before any is added, so a bad size in the middle
    // can't leave half a run asked about.
    const many = Array.isArray(body.lines);
    const asks = many ? body.lines : [body.line || {}];
    if (!asks.length) return send(res, 400, { ok: false, error: 'Nothing to add.' });
    if (asks.length > MAX_GROUP)
      return send(res, 400, { ok: false, error: `At most ${MAX_GROUP} sizes in one ask.` });
    if (Number(cart.line_count) + asks.length > MAX_LINES)
      return send(res, 409, { ok: false, error: `A request holds at most ${MAX_LINES} lines.` });

    const prepared = [];
    for (const l of asks) {
      const p = prepareLine(l, user, cart);
      if (p.error) return send(res, 400, { ok: false, error: p.error });
      prepared.push(p);
    }
    if (many && new Set(prepared.map((p) => p.sku)).size > 1)
      return send(res, 400, { ok: false, error: 'One shoe per ask — every size in it must be the same SKU.' });
    // Each size once: the shared card is answered by size, so a second line of the same
    // size could never be named in the reply and would be turned down as "left out".
    if (many) {
      const keys = prepared.map((p) => sizeKey(p.row.size));
      const twice = keys.filter((k, i) => k && keys.indexOf(k) !== i);
      if (twice.length)
        return send(res, 400, { ok: false, error: `Size ${[...new Set(twice)].join(', ')} is in this ask twice — each size once.` });
    }
    const sku = prepared[0].sku;

    // A photo of the shoe is what the approver decides on — they are not in the shop and
    // the style code is four characters from a different pair. Checked HERE now rather
    // than only at submit, because for a buyer the add IS the submit.
    if (isOwnBuyer(user, cart) && !(await cartHasShoePhoto(cartId, sku)))
      return send(res, 400, {
        ok: false,
        error: `Add a photo of ${sku} first — the desk decides on it and cannot see the shoe. One photo covers every size of it.`,
      });

    const added = [];
    for (const p of prepared) added.push({ p, line: await addBuyCartLine(cartId, p.row, user) });
    // AFTER the response, never before it. The buyer is standing in a shop with a shoe
    // in one hand and a phone in the other, and Alias runs 16s on an ordinary day and
    // 20–45s on a bad one — measured. Pricing inline made "Add to request" hang for all
    // of it, which is the difference between a tool you use on a shop floor and one you
    // stop using. Nothing is lost by deferring it: the buyer is not allowed to see the
    // call anyway, and the approver reads the line minutes or hours later.
    //
    // If it fails, the line simply stays unpriced — an ordinary state with a way back
    // (the desk's "Price it"), and the same state a timed-out quote has always left.
    // Tell Telegram AFTER the market read, not with the add — a card that goes out first
    // says "not priced" on every pair, which is the one thing the approver most needs.
    // Both are fire-and-forget: the buyer is in a shop and must never wait on either.
    // `photos` is read now because the file rows are already there.
    const asking = isOwnBuyer(user, cart);
    const photos = asking ? await cartShoePhotos(cartId, sku) : [];
    // One size keeps the tap-button card even with a tip — the tip gets its own two buttons
    // (owner, 2026-10-27: replies only when a shoe has several sizes).
    const tell = { notify: asking, photos };
    if (added.length > 1) {
      priceRunInBackground(cartId, added, cart.cost_stack || {}, tell);
    } else {
      const [{ p, line }] = added;
      if (p.toPrice) {
        priceInBackground(cartId, Number(line.id), { ...p.market }, cart.cost_stack || {}, tell);
      } else if (asking) {
        notifyLineAsked(cartId, Number(line.id), { photoFileId: photos[0] ?? null, photoCount: photos.length });
      }
    }
    // ADDING A PAIR *IS* ASKING ABOUT IT. There is no separate "send for approval" for a
    // buyer any more: they are standing in a shop and the desk should be able to answer
    // while the shoe is still on the shelf. A trip that ends with the buyer remembering
    // to press Send is a trip where the first pair sat unasked for an hour.
    //
    // Only for the BUYER. A desk adding a line on somebody's behalf is data entry, not a
    // question being asked, and flipping the request's state under them would be a
    // surprise. Their add leaves the status exactly as it was.
    // On a FUNDED request `askBuyCart` matches no row and the status stays put — the
    // new line is pending on a funded request, which is exactly what it is.
    const asked = isOwnBuyer(user, cart) ? await askBuyCart(cartId, user) : null;
    // The line goes back to whoever added it as THEY may see it — a buyer's copy has
    // never carried a call, and must not start carrying one on the way out of the add.
    return send(res, 200, {
      ok: true,
      ...(many
        ? { lines: added.map((a) => redactLineForViewer(a.line, user)) }
        : { line: redactLineForViewer(added[0].line, user) }),
      ...(asked ? { cart: redactCartForViewer(asked, user) } : {}),
    });
  } catch (e) {
    console.error('[cart/line]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the request.' });
  }
}

/**
 * One asked-about line, checked and shaped for `addBuyCartLine` — or `{ error }`.
 * Shared by the single add and the several-sizes add so the two can't disagree.
 */
function prepareLine(l, user, cart) {
  const sku = String(l.sku ?? '').trim().toUpperCase().slice(0, 40);
  // NO QUANTITY. The buyer reports what they found in a shop — this shoe, this size,
  // this price on the ticket — and how many to buy is the decision being asked for, so
  // it belongs to whoever approves it (`cart/decide`). Defaulting to 1 here would put
  // a number nobody stated into the funding total.
  const qty = null;
  // HOW MANY THE SHOP HAS, which is NOT the same question and is the buyer's to answer.
  // `qty` above is what we decide to buy; this is what is sitting on the shelf, and it
  // is the number the approver was missing when they chose one. Optional on purpose —
  // blank means "didn't count", and a guessed number the approver cannot tell apart
  // from a counted one is worse than no number at all. 0 is not a meaningful answer
  // (nobody adds a line for a size the shop hasn't got), so it reads as blank.
  const availableQty = Number.isInteger(Number(l.availableQty)) && Number(l.availableQty) > 0
    ? Math.min(Number(l.availableQty), 999) : null;
  const shelfPrice = money(l.shelfPrice);
  if (!sku) return { error: 'A SKU is required.' };
  // The shelf price is the funding target for this line. Without it a request can be
  // approved for an amount nobody can compute, so it is required rather than defaulted
  // to zero — a $0 pair would silently fund nothing.
  if (shelfPrice == null || shelfPrice <= 0)
    return { error: 'Enter the price on the shelf — it is what the gift cards have to cover.' };

  // Required: the market read, the payout and the profit are all per size, so a pair with
  // no size can be asked about but never priced, and the desk would decide on nothing.
  const size = String(l.size ?? '').trim().slice(0, 20) || null;
  if (!isRealSize(size)) return { error: NEEDS_SIZE };
  const upc = String(l.upc ?? '').replace(/\D/g, '').slice(0, 20) || null;
  // PREMIUM, and the tip the buyer proposes for THIS shoe only (per pair). Only a premium
  // shoe can carry one; a tip box left blank means no tip asked, never $0.
  const premium = l.premium === true;
  const tipProposed = premium && !blank(l.tipProposed) ? money(l.tipProposed) : null;
  if (premium && !blank(l.tipProposed) && !(tipProposed > 0))
    return { error: 'Enter the tip you are proposing per pair, or untick "Propose a tip".' };
  if (tipProposed != null && tipProposed > 500)
    return { error: 'A tip above $500 a pair can’t be right — check the amount.' };
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
    call = repriceLine({ shelf_price: shelfPrice, alias_price: null, stockx_price: null, liquidity: null,
      tip_proposed: tipProposed, tip_status: tipProposed != null ? 'proposed' : null },
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
    // The screen's figures know nothing of this shoe's own tip — re-derive from the same
    // market prices with it included, so the line's cost says what the pair really costs.
    if (tipProposed != null) {
      const withTip = repriceLine({ shelf_price: shelfPrice, alias_price: call.aliasPrice, stockx_price: call.stockxPrice,
        liquidity: call.liquidity, tip_proposed: tipProposed, tip_status: 'proposed' }, cart.cost_stack || {});
      // Only the cost when the screen sent no market prices — a null call must not
      // replace the one it did send.
      if (withTip) call = call.aliasPrice || call.stockxPrice ? { ...call, ...withTip } : { ...call, finalCost: withTip.finalCost };
    }
  }
  return {
    sku, toPrice,
    market: { sku, size, upc, basis, shelfPrice, tipProposed },
    row: {
      sku, size, qty, availableQty, shelfPrice, upc, premium, tipProposed,
      // FULL BOX — the buyer says the pair comes in its own box, complete. Unticked = not said.
      fullBox: l.fullBox === true,
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
    },
  };
}

/**
 * Several sizes of one shoe: priced ONE AT A TIME (forty at once would be forty
 * simultaneous Alias calls off one button — the reason the screen used to send them in
 * sequence), then ONE card for all of them, after the last read so every row carries its call.
 */
async function priceRunInBackground(cartId, added, stack, tell) {
  for (const { p, line } of added) {
    if (p.toPrice) await priceInBackground(cartId, Number(line.id), { ...p.market }, stack, null);
  }
  if (!tell?.notify) return;
  await notifyGroupAsked(cartId, added.map((a) => Number(a.line.id)), {
    photoFileId: tell.photos?.[0] ?? null,
    photoCount: tell.photos?.length ?? 0,
  });
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
async function priceInBackground(cartId, lineId, { sku, size, upc, basis, shelfPrice, tipProposed = null }, stack, tell = null) {
  // In its own function so "nothing to price" can RETURN without skipping the card below.
  // It used to `return` straight out of this one, so a size with no Alias or StockX market
  // never got a Telegram card at all — the exact case the comment below rules out.
  await priceLineNow(cartId, lineId, { sku, size, upc, basis, shelfPrice, tipProposed }, stack);
  // Whatever happened above — priced, unpriced, or upstream down — the desk still has to
  // be told the pair was asked about. A market outage must not swallow the question.
  // WHETHER WE EVEN TRY is the other half of "no card arrived". A line the buyer added
  // that was never treated as a question leaves no trace at all otherwise.
  if (!tell) return;   // one size of a run — the run sends its own card (priceRunInBackground)
  if (!tell.notify) console.log(`[cart/line] line ${lineId} priced — no card (not the buyer's own ask)`);
  if (tell?.notify) {
    await notifyLineAsked(cartId, lineId, { photoFileId: tell.photos?.[0] ?? null, photoCount: tell.photos?.length ?? 0, edited: tell.edited ?? null });
  }
}

async function priceLineNow(cartId, lineId, { sku, size, upc, basis, shelfPrice, tipProposed }, stack) {
  try {
    // The size's MARKET SALES are read beside the price (Alias recent sales — how many
    // sold, avg/high/low) and kept on the line whatever the price read does: the card
    // and the approver's screen both show them. Their failure never costs the price.
    const [read, sales] = await Promise.all([
      readMarketForLine({ sku, size, upc, consigned: basis === 'consigned' }).then((v) => ({ v }), (e) => ({ e })),
      readMarketSales({ sku, size }).catch(() => null),
    ]);
    if (sales) await setBuyCartLineSales(cartId, lineId, sales).catch((e) => console.warn('[cart/line] sales snapshot not saved:', e.message));
    if (read.e) throw read.e;
    const m = read.v;
    // Nothing answered. Leave the row alone rather than stamping two zeros on it — a
    // stored zero reads as "priced, and worthless".
    if (!m.priced) return;
    const snap = {
      ...repriceLine({
        shelf_price: shelfPrice,
        alias_price: m.aliasPrice, stockx_price: m.stockxPrice, liquidity: m.liquidity,
        tip_proposed: tipProposed, tip_status: tipProposed != null ? 'proposed' : null,
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
}
