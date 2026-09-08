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
  getBuyCart, getBuyCartLine, addBuyCartLine, updateBuyCartLine, removeBuyCartLine, dbConfigured,
} from '../_lib/db.js';
import { cartVisibleTo, hasCostPrivilege, shelfPricesEditable, repriceLine } from '../_lib/buycart.js';

const MAX_LINES = 200;
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
    } else if (cart.status !== 'draft') {
      return send(res, 409, { ok: false, error: 'This request has been submitted — ask for it to be sent back before changing it.' });
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
      if (!bits.length) return send(res, 200, { ok: true, line: was, unchanged: true });
      // The buy call is re-derived only when the SHELF PRICE moved, and only from the
      // market prices already captured on the line — the call still answers "at the
      // prices the buyer was looking at" (api/_lib/buycart.js repriceLine).
      const call = shelfMoved ? repriceLine({ ...was, shelf_price: patch.shelfPrice }, cart.cost_stack || {}) : null;

      const line = await updateBuyCartLine(cartId, Number(body.lineId), patch, user, call,
        `${was.sku}${was.size ? ` size ${was.size}` : ''}${bits.length ? ` — ${bits.join(', ')}` : ''}`);
      if (!line) return send(res, 404, { ok: false, error: 'That line does not exist.' });
      return send(res, 200, { ok: true, line });
    }

    if (Number(cart.line_count) >= MAX_LINES)
      return send(res, 409, { ok: false, error: `A request holds at most ${MAX_LINES} lines.` });

    const l = body.line || {};
    const sku = String(l.sku ?? '').trim().toUpperCase().slice(0, 40);
    const qty = Number.isInteger(Number(l.qty)) && Number(l.qty) > 0 ? Math.min(Number(l.qty), 999) : 1;
    const shelfPrice = money(l.shelfPrice);
    if (!sku) return send(res, 400, { ok: false, error: 'A SKU is required.' });
    // The shelf price is the funding target for this line. Without it a request can be
    // approved for an amount nobody can compute, so it is required rather than defaulted
    // to zero — a $0 pair would silently fund nothing.
    if (shelfPrice == null || shelfPrice <= 0)
      return send(res, 400, { ok: false, error: 'Enter the price on the shelf — it is what the gift cards have to cover.' });

    const line = await addBuyCartLine(cartId, {
      sku,
      size: String(l.size ?? '').trim().slice(0, 20) || null,
      qty, shelfPrice,
      name: String(l.name ?? '').trim().slice(0, 200) || null,
      colorway: String(l.colorway ?? '').trim().slice(0, 120) || null,
      gender: String(l.gender ?? '').trim().slice(0, 20) || null,
      upc: String(l.upc ?? '').replace(/\D/g, '').slice(0, 20) || null,
      // The verdict snapshot, as the buyer saw it. Stored, never recomputed here — the
      // screen it came from is the only place these numbers are derived, so a second
      // code path can never disagree with the calculator about the same pair.
      verdict: ['buy', 'watch', 'pass'].includes(l.verdict) ? l.verdict : null,
      finalCost: money(l.finalCost), bestPlatform: String(l.bestPlatform ?? '').slice(0, 20) || null,
      bestPayout: money(l.bestPayout), profit: num(l.profit), roi: num(l.roi),
      aliasPrice: money(l.aliasPrice), stockxPrice: money(l.stockxPrice),
      liquidity: String(l.liquidity ?? '').slice(0, 20) || null,
      basis: l.basis === 'with_you' ? 'with_you' : (l.basis === 'consigned' ? 'consigned' : null),
    }, user);
    return send(res, 200, { ok: true, line });
  } catch (e) {
    console.error('[cart/line]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the request.' });
  }
}
