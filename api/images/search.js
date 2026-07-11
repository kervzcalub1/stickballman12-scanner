// GET /api/images/search?sku=DZ5485-612 -> { ok, configured, product }
// PH "Image Finder": resolve a SKU on the KicksDB GOAT catalog and return the hero +
// the curated GOAT gallery (`images[]` — real retail angles incl. outsole/top) + the
// index-stable suggestions. Read-only; no bytes are stored here — the client picks
// angles, then POSTs /api/images/import.
import { send, applySecurity, rateLimit, requireRole, cleanSku } from '../_lib/util.js';
import { kicksdbConfigured, kicksdbImagesBySku } from '../_lib/kicksdb.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!kicksdbConfigured())
    return send(res, 503, { ok: false, configured: false, error: 'Image lookup isn’t configured on the server (KICKSDB_KEY missing).' });

  const sku = normSku(new URL(req.url, 'http://x').searchParams.get('sku'));
  if (!sku) return send(res, 400, { ok: false, error: 'A valid SKU is required.' });

  try {
    const product = await kicksdbImagesBySku(sku);
    if (!product) return send(res, 200, { ok: true, configured: true, product: null });
    return send(res, 200, { ok: true, configured: true, product });
  } catch (e) {
    console.error('[images/search]', e.message);
    return send(res, 502, { ok: false, error: 'Image lookup failed.' });
  }
}
