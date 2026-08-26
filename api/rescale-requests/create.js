// POST /api/rescale-requests/create
//   { sku, name?, sizes:[{size,qty}], price?, reason, note? } -> { ok, id }
// PH flags a SKU for the warehouse to recount/rescan. PH team (admin allowed).
import { getJsonBody, send, applySecurity, rateLimit, requireRole, cleanSku, skuCodes } from '../_lib/util.js';
import { createRescaleRequest, linkRescaleRequestItems, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const sku = cleanSku(body.sku);
  if (!sku) return send(res, 400, { ok: false, error: 'Enter a valid SKU.' });
  const reason = String(body.reason || '').trim().slice(0, 80) || null;
  if (!reason) return send(res, 400, { ok: false, error: 'Pick a reason.' });

  // Sanitize sizes: [{ size, qty }]
  const sizes = (Array.isArray(body.sizes) ? body.sizes : [])
    .map((s) => ({ size: String(s.size ?? '').trim().slice(0, 24), qty: Math.max(1, Math.min(9999, Number(s.qty) || 1)) }))
    .filter((s) => s.size)
    .slice(0, 100);
  if (!sizes.length) return send(res, 400, { ok: false, error: 'Add at least one size and quantity.' });

  const priceRaw = body.price === '' || body.price == null ? null : Number(body.price);
  if (priceRaw != null && (!Number.isFinite(priceRaw) || priceRaw < 0 || priceRaw > 1_000_000))
    return send(res, 400, { ok: false, error: 'Invalid price.' });

  const name = String(body.name || '').trim().slice(0, 200) || null;
  const note = String(body.note || '').trim().slice(0, 2000) || null;

  // A shoe with several style codes: `sku` is what PH asked the warehouse to COUNT
  // (one code, or all of them), `skuAll` is every code that matched. The selection is
  // checked to be a SUBSET of the matched set — otherwise this field would be a way to
  // file a request against a shoe the lookup never returned.
  const chosen = skuCodes(sku);
  const all = skuCodes(body.skuAll || sku);
  const skuAll = all.length ? all.join('/') : null;
  if (skuAll && !chosen.every((c) => all.some((x) => x.toUpperCase() === c.toUpperCase())))
    return send(res, 400, { ok: false, error: 'Pick one of this shoe’s style codes, or all of them.' });

  try {
    const r = await createRescaleRequest({ sku: chosen.join('/') || sku.replace(/\s+/g, '-'), skuAll, name, sizes, price: priceRaw, reason, note, by: user.name || user.username || '' });
    // Which PAIRS this is about — sent only by the New Inventory row modal, which is
    // the only place that knows. Best-effort on purpose: a request must file even if
    // the linking fails, because the ask is the point and the link is an optimisation.
    let linked = 0;
    try { linked = await linkRescaleRequestItems(r.id, body.vins); }
    catch (e) { console.warn('[rescale-requests/create] link failed:', e.message); }
    return send(res, 200, { ok: true, id: r.id, linked });
  } catch (e) {
    console.error('[rescale-requests/create]', e.message);
    return send(res, 500, { ok: false, error: 'Could not submit the request.' });
  }
}
