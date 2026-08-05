// GET /api/items/find?code=<upc|sku>  ->  { ok, product, units }
// Exact UPC / SKU lookup against OUR OWN stock. The Box Labels tool calls this
// BEFORE the third-party catalogue: a pair we've already handled is the record
// that matters, and it's the one the catalogue is least likely to know (old
// stock, in-store buys, anything typed in by hand).
//
// `product` folds the matches into the shape the catalogue endpoints return, so
// the caller can treat a local hit and a catalogue hit identically. `units` are
// the real pairs behind it, so the user can jump straight to a VIN instead of
// minting a duplicate.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { findStockByCode, dbConfigured } from '../_lib/db.js';

// Sizes ascending, same as the catalogue endpoints (handles "9.5" / "10Y" / "8W").
function sortSizes(list) {
  const num = (s) => { const m = String(s).match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN; };
  return [...list].sort((a, b) => {
    const na = num(a); const nb = num(b);
    if (Number.isNaN(na) && Number.isNaN(nb)) return String(a).localeCompare(String(b));
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return na - nb || String(a).localeCompare(String(b));
  });
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const code = (new URL(req.url, 'http://x').searchParams.get('code') || '').trim();
  if (!code) return send(res, 400, { ok: false, error: 'Provide a code.' });

  try {
    const rows = await findStockByCode(code);
    if (!rows.length) return send(res, 200, { ok: true, product: null, units: [] });

    // Newest row wins for the descriptive fields, but fall back across the set —
    // an older row may carry a colorway or UPC the newest one never got.
    const first = (pick) => rows.map(pick).find((v) => v != null && String(v).trim() !== '') ?? null;
    const sizes = sortSizes([...new Set(rows.map((r) => String(r.size || '').trim()).filter(Boolean))]);

    return send(res, 200, {
      ok: true,
      product: {
        name: first((r) => r.name),
        sku: first((r) => r.sku),
        upc: first((r) => r.upc),
        colorway: first((r) => r.colorway),
        gender: first((r) => r.gender),
        sizes,
        source: 'inventory',
      },
      units: rows.map((r) => ({
        vin: r.vin, size: r.size, status: r.status, upc: r.upc,
        name: r.name, sku: r.sku, colorway: r.colorway,
        withBox: r.with_box, locationCode: r.location_code,
      })),
    });
  } catch (e) {
    console.error('[items/find]', e.message);
    return send(res, 500, { ok: false, error: 'Lookup failed.' });
  }
}
