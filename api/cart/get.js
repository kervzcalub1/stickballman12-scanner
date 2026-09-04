// GET /api/cart/get?id=…  -> { ok, cart:{…, lines, giftCards, files, receiptLines, events, checks } }
//
// The whole record for one screen, with the ten closing conditions evaluated alongside
// it so the page and the server never disagree about whether it can be closed.
//
// Gift cards come back MASKED (last four + balance). Reading a full code is its own
// endpoint, and it writes an audit event first — see cart/gc-reveal.js.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getBuyCartFull, dbConfigured } from '../_lib/db.js';
import { cartVisibleTo, cartCloseChecks, tillOverrunWarning } from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team', 'gc_issuer', 'auditor']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'A valid id is required.' });

  try {
    const cart = await getBuyCartFull(id);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    const checks = await cartCloseChecks(cart);
    return send(res, 200, { ok: true, cart: { ...cart, checks, tillWarning: tillOverrunWarning(cart) } });
  } catch (e) {
    console.error('[cart/get]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load that buying request.' });
  }
}
