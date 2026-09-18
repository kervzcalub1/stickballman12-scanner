// GET /api/upc-for-size?sku=305381-007&size=12  ->  { ok, upc, product }
// The UPC of one SIZE of a style, from the official StockX catalogue — for a box
// label on a pair we have no record of. The Box Labels tool used to ask a person to
// read the number off the tongue label; the catalogue carries a barcode per variant,
// and it matched our own record on the first check (305381-007 / 12 → 198965021212).
//
// `upc` is null when the size is not in the run or has no barcode, and `product` is
// null when the style is unknown — the screen then falls back to asking, as before.
// The style is matched EXACTLY on its ID (`stockxProductBySku`); `product.exact`
// says whether it was, so an inexact hit is never quietly stamped on a label.
import { send, applySecurity, rateLimit, requireRole } from './_lib/util.js';
import { stockxConfigured, stockxUpcForSkuSize } from './_lib/stockx.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!stockxConfigured()) return send(res, 503, { ok: false, error: 'StockX is not configured.' });

  const q = new URL(req.url, 'http://x').searchParams;
  const sku = (q.get('sku') || '').trim();
  const size = (q.get('size') || '').trim();
  if (!sku || !size) return send(res, 400, { ok: false, error: 'Provide a sku and a size.' });

  try {
    const r = await stockxUpcForSkuSize(sku, size);
    if (!r) return send(res, 200, { ok: true, upc: null, product: null });
    const { product } = r;
    return send(res, 200, {
      ok: true,
      upc: product.exact ? r.upc : null,   // never a barcode off a different colourway
      product: { name: product.title, styleId: product.styleId, colorway: product.colorway, exact: product.exact },
    });
  } catch (e) {
    console.error('[upc-for-size]', e.message);
    return send(res, 502, { ok: false, error: 'Could not reach StockX right now.' });
  }
}
