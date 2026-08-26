// POST /api/rescale-requests/update
//   { id, sku?, skuAll?, name?, sizes:[{size,qty}], price?, reason, note? } -> { ok }
// PH corrects a request it already submitted — a miscounted size, one it forgot to
// list, the wrong reason or price.
//
// PH TEAM ONLY, and deliberately not via requireRole: that auto-allows admin, and a
// request is the requesting team's own to correct. Same explicit check the other
// PH-owned writes use (ph/update.js, ph/set-goat.js, rescale-requests/cancel.js) —
// ph_team, plus superadmin because that env account IS the PH workspace.
//
// Only an `open` request is editable; `updateRescaleRequest` enforces that in SQL, so
// an audit landing at the same moment wins and we answer 409 rather than rewriting the
// numbers a shelf count was measured against.
//
// The SKU IS editable (2026-08-27, by explicit request): a typo caught before anyone
// has counted is cheaper to fix than to cancel and re-raise. It retargets the request
// — the warehouse's queue entry changes shoe and the New Inventory chip moves with it.
// `skuAll` moves with it too, or the code picker would offer the old shoe's codes.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, skuCodes, cleanSku } from '../_lib/util.js';
import { updateRescaleRequest, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (user.role !== 'ph_team' && user.role !== 'superadmin')
    return send(res, 403, { ok: false, error: 'Only PH Team can edit a rescale request.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const id = Number(body.id) || 0;
  if (!id) return send(res, 400, { ok: false, error: 'Missing request id.' });

  // Same validation as create.js — an edit must not be able to write a shape the
  // original submit would have refused.
  const reason = String(body.reason || '').trim().slice(0, 80) || null;
  if (!reason) return send(res, 400, { ok: false, error: 'Pick a reason.' });

  const sizes = (Array.isArray(body.sizes) ? body.sizes : [])
    .map((s) => ({ size: String(s.size ?? '').trim().slice(0, 24), qty: Math.max(1, Math.min(9999, Number(s.qty) || 1)) }))
    .filter((s) => s.size)
    .slice(0, 100);
  if (!sizes.length) return send(res, 400, { ok: false, error: 'Add at least one size and quantity.' });

  const price = body.price === '' || body.price == null ? null : Number(body.price);
  if (price != null && (!Number.isFinite(price) || price < 0 || price > 1_000_000))
    return send(res, 400, { ok: false, error: 'Invalid price.' });

  const name = String(body.name || '').trim().slice(0, 200) || null;
  const note = String(body.note || '').trim().slice(0, 2000) || null;

  // The SKU, and which of its style codes the warehouse should count. Same shape and
  // same validation as create.js: the selection must be a SUBSET of the code set that
  // was matched for it. That check is what stops `sku` and `sku_all` drifting apart —
  // a request whose picker offers codes its SKU doesn't have is unreadable to both
  // teams. Omitted entirely (not sent) leaves the SKU exactly as it was.
  let sku = null;
  let skuAll = null;
  if (body.sku != null && String(body.sku).trim()) {
    const clean = cleanSku(body.sku);
    if (!clean) return send(res, 400, { ok: false, error: 'Enter a valid SKU.' });
    const chosen = skuCodes(clean);
    const all = skuCodes(body.skuAll || clean);
    if (!chosen.length) return send(res, 400, { ok: false, error: 'Enter a valid SKU.' });
    if (!chosen.every((c) => all.some((x) => x.toUpperCase() === c.toUpperCase())))
      return send(res, 400, { ok: false, error: 'Pick one of this shoe’s style codes, or all of them.' });
    sku = chosen.join('/');
    skuAll = all.join('/') || sku;
  }

  try {
    const r = await updateRescaleRequest(id, { name, sizes, price, reason, note, sku, skuAll }, user.name || user.username || '');
    if (!r.ok) {
      if (!r.status) return send(res, 404, { ok: false, error: 'That request no longer exists.' });
      if (r.status === 'cancelled') return send(res, 409, { ok: false, error: 'This request was cancelled — it can no longer be edited.' });
      return send(res, 409, {
        ok: false,
        error: 'Too late to edit — the warehouse has already counted this one. Reload to see their numbers.',
      });
    }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[rescale-requests/update]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the changes.' });
  }
}
