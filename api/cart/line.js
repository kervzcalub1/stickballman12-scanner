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
  getBuyCart, addBuyCartLine, updateBuyCartLine, removeBuyCartLine, dbConfigured,
} from '../_lib/db.js';
import { cartVisibleTo } from '../_lib/buycart.js';

const MAX_LINES = 200;
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };

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
    if (cart.status !== 'draft')
      return send(res, 409, { ok: false, error: 'This request has been submitted — ask for it to be sent back before changing it.' });

    if (body.remove) {
      const gone = await removeBuyCartLine(cartId, Number(body.lineId), user);
      if (!gone) return send(res, 404, { ok: false, error: 'That line is already gone.' });
      return send(res, 200, { ok: true, removed: gone });
    }

    if (body.patch) {
      const patch = {
        qty: Number.isInteger(Number(body.patch.qty)) && Number(body.patch.qty) > 0 ? Number(body.patch.qty) : null,
        shelfPrice: body.patch.shelfPrice == null ? null : money(body.patch.shelfPrice),
        size: body.patch.size == null ? null : String(body.patch.size).trim().slice(0, 20) || null,
      };
      const line = await updateBuyCartLine(cartId, Number(body.lineId), patch, user);
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
      bestPayout: money(l.bestPayout), profit: Number.isFinite(Number(l.profit)) ? Number(l.profit) : null,
      roi: Number.isFinite(Number(l.roi)) ? Number(l.roi) : null,
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
