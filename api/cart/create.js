// POST /api/cart/create  { retailer?, purpose?, restrictions? }  -> { ok, cart }
//
// A buyer opens a request. The account comes off the TOKEN, never the body — a posted
// buyer id would let one buyer open a request that spends against another's name.
//
// The cost stack is snapshotted from the buyer's own payout preset at this moment, and
// every verdict on the request is computed against that frozen copy. A preset edited
// next week must not restate what an approver was looking at when they said yes.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { createBuyCart, listPayoutPresets, listSupplierUsers, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Staff can raise one on a buyer's behalf; the buyer is then named in the body.
  const user = requireRole(req, res, ['supplier', 'ph_team', 'warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const byBuyer = user.role === 'supplier' && !isPrivileged(user.role);
  const buyerUserId = byBuyer
    ? Number(user.uid)
    : (Number.isInteger(Number(body.buyerUserId)) && Number(body.buyerUserId) > 0 ? Number(body.buyerUserId) : null);
  if (!Number.isInteger(buyerUserId) || buyerUserId <= 0)
    return send(res, 400, { ok: false, error: 'Say which buyer this request is for.' });
  // Staff raising one ON BEHALF of a buyer: the id is re-checked against the real buyer
  // list rather than trusted. Without this a request could be attributed to an account
  // that isn't a buyer at all — a staff id, or one that no longer exists — and the whole
  // trail hangs off who the buyer was. Same check, same reason as payout/presets.js.
  if (!byBuyer) {
    const known = await listSupplierUsers();
    if (!known.some((u) => Number(u.id) === buyerUserId))
      return send(res, 400, { ok: false, error: 'That is not a buyer account.' });
  }

  try {
    // Their own cost stack — the same scoping the calculator uses (supplier_user_id,
    // never the preset's name, which drifts the moment either side is renamed).
    const presets = await listPayoutPresets({ supplierUserId: buyerUserId });
    const p = presets[0] || null;
    // `listPayoutPresets` already hands these back camelCased and numeric (presetOut) —
    // reading the raw column names here got a stack of silent zeros, which is the worst
    // possible failure for this field: a cost stack of all-zero rates looks like a
    // legitimate "no discounts" supplier rather than like a bug.
    const costStack = p ? {
      presetName: p.name,
      storePct: p.storePct, promoPct: p.promoPct, giftPct: p.giftPct,
      cashbackPct: p.cashbackPct, taxPct: p.taxPct,
      tipAmt: p.tipAmt, shippingAmt: p.shippingAmt,
    } : null;

    const cart = await createBuyCart({
      buyerUserId,
      buyerName: byBuyer
        ? String(user.name || user.username || '').slice(0, 120)
        : String(body.buyerName ?? '').trim().slice(0, 120) || `Buyer #${buyerUserId}`,
      retailer: String(body.retailer ?? '').trim().slice(0, 120) || null,
      purpose: String(body.purpose ?? '').trim().slice(0, 2000) || null,
      restrictions: String(body.restrictions ?? '').trim().slice(0, 2000) || null,
      presetId: p ? p.id : null,
      costStack,
      actor: user,
    });
    return send(res, 200, { ok: true, cart });
  } catch (e) {
    console.error('[cart/create]', e.message);
    return send(res, 500, { ok: false, error: 'Could not open that buying request.' });
  }
}
