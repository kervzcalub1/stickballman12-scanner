// GET /api/cart/get?id=…  -> { ok, cart:{…, lines, giftCards, files, receiptLines, events, checks } }
//
// The whole record for one screen, with the ten closing conditions evaluated alongside
// it so the page and the server never disagree about whether it can be closed.
//
// Gift cards come back MASKED (last four + balance). Reading a full code is its own
// endpoint, and it writes an audit event first — see cart/gc-reveal.js.
//
// A BUYER's copy is redacted: the buy call belongs to whoever approves the request, so
// the verdict, profit, ROI, payout and market prices are stripped from every line and
// from the event trail — see `canSeeBuyCall` in api/_lib/buycart.js.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getBuyCartFull, dbConfigured } from '../_lib/db.js';
import { cartVisibleTo, cartCloseChecks, tillOverrunWarning, canSeeBuyCall, redactCartForViewer, requireBuyerAccess } from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
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
    // The buy call is the approver's, and a supplier's copy of the request never
    // carries it — not on the lines and not in the trail, which used to print the
    // verdict in plain words. Stripped here, at the read boundary, rather than left to
    // the screen: a hidden column is not a control (`canSeeBuyCall`).
    const forViewer = redactCartForViewer(cart, user);
    // The till-overrun warning is derived from the cost stack, so it goes with it: it
    // is a note for whoever funds the request, and to a buyer it would be an unexplained
    // number computed from rates they cannot see.
    const till = canSeeBuyCall(user) ? tillOverrunWarning(cart) : null;
    return send(res, 200, { ok: true, cart: { ...forViewer, checks, tillWarning: till } });
  } catch (e) {
    console.error('[cart/get]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load that buying request.' });
  }
}
