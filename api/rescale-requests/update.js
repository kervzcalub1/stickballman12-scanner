// POST /api/rescale-requests/update { id, name?, sizes:[{size,qty}], price?, reason, note? } -> { ok }
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
// The SKU is not editable here on purpose — see the note on `updateRescaleRequest`.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, skuCodes } from '../_lib/util.js';
import { updateRescaleRequest, dbConfigured, listRescaleRequests } from '../_lib/db.js';

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

  // Re-picking which style code(s) the warehouse should count. Validated against the
  // request's OWN `sku_all` read from the database, never against anything the client
  // sent — otherwise "narrow the codes" would be a way to retarget the request at a
  // different shoe, which is exactly what the no-SKU-editing rule exists to prevent.
  let sku = null;
  if (body.sku) {
    const cur = (await listRescaleRequests(null, null, null)).find((x) => x.id === id);
    if (!cur) return send(res, 404, { ok: false, error: 'That request no longer exists.' });
    const all = skuCodes(cur.sku_all || cur.sku);
    const chosen = skuCodes(body.sku);
    if (!chosen.length || !chosen.every((c) => all.some((x) => x.toUpperCase() === c.toUpperCase())))
      return send(res, 400, { ok: false, error: 'Pick one of this shoe’s style codes, or all of them.' });
    sku = chosen.join('/');
  }

  try {
    const r = await updateRescaleRequest(id, { name, sizes, price, reason, note, sku }, user.name || user.username || '');
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
