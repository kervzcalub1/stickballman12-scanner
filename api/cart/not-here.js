// POST /api/cart/not-here  { cartId } -> { ok, shoes: [{ sku, name, summary }], more }
//
// The website's copy of the Telegram card's "Not in warehouse yet", for each shoe on a request.
// Staff only: the count crosses every supplier's requests and orders, and a supplier reads only
// their own. A shoe that couldn't be read comes back with `summary: null`, never as none.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, blockIfMustChange } from '../_lib/util.js';
import { getBuyCartFull, notInWarehouseForSku, dbConfigured } from '../_lib/db.js';
import { cartVisibleTo, canSeeBuyCall } from '../_lib/buycart.js';
import { notHereSummary } from '../../src/lib/notHere.js';

const MAX_SHOES = 40;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  if (!canSeeBuyCall(user)) return send(res, 403, { ok: false, error: 'You do not have access to this.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCartFull(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });

    const names = new Map();
    for (const l of cart.lines || []) {
      const sku = String(l.sku || '').trim();
      if (sku && !names.has(sku)) names.set(sku, l.name || null);
    }
    const skus = [...names.keys()];
    const shoes = await Promise.all(skus.slice(0, MAX_SHOES).map(async (sku) => {
      try {
        return { sku, name: names.get(sku), summary: notHereSummary(await notInWarehouseForSku(sku)) };
      } catch (e) {
        console.warn(`[cart/not-here] ${sku}:`, e.message);
        return { sku, name: names.get(sku), summary: null };
      }
    }));
    return send(res, 200, { ok: true, shoes, more: Math.max(0, skus.length - MAX_SHOES) });
  } catch (e) {
    console.error('[cart/not-here]', e.message);
    return send(res, 500, { ok: false, error: 'Could not read what is on its way.' });
  }
}
