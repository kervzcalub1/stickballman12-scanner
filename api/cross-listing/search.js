// GET /api/cross-listing/search?q=<shoe name or SKU>
//   -> { ok, results:[{ catalogId, sku, name, image, colorway, gender, released, sizes:[{ label, value }] }] }
// Alias's own catalogue search, by NAME (docs/context/alias-cross-listing.md): the user
// types "Nike Dunk Low Light Carbon" and ticks the entries that are the same shoe. Read-only.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { aliasApiGet } from '../_lib/alias.js';
import { skuText } from '../../src/lib/crossListing.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 40 })) return send(res, 429, { ok: false, error: 'Please wait a moment before searching again.' });
  const q = String(new URL(req.url, 'http://x').searchParams.get('q') ?? '').trim().slice(0, 120);
  if (q.length < 3) return send(res, 400, { ok: false, error: 'Type at least 3 letters of the shoe’s name or SKU.' });
  const key = process.env.ALIAS_API_KEY;
  if (!key) return send(res, 503, { ok: false, error: 'Alias is not configured on the server.' });
  try {
    const r = await aliasApiGet('/api/v1/catalog', { token: key, query: { query: q, limit: '40' }, timeoutMs: 45_000 });
    if (!r.ok) return send(res, 502, { ok: false, error: `Alias answered HTTP ${r.status} — try again.` });
    const results = (Array.isArray(r.data?.catalog_items) ? r.data.catalog_items : []).filter((c) => c?.catalog_id && c?.sku).map((c) => ({
      catalogId: c.catalog_id, sku: skuText(c.sku), name: c.name || c.nickname || null, image: c.main_picture_url || null,
      colorway: c.colorway || null, gender: c.gender || null, released: c.release_date ? String(c.release_date).slice(0, 10) : null,
      sizes: (Array.isArray(c.allowed_sizes) ? c.allowed_sizes : []).filter((s) => s && s.value != null)
        .map((s) => ({ label: String(s.display_name ?? s.value).trim(), value: Number(s.value) })),
    }));
    return send(res, 200, { ok: true, results });
  } catch (e) {
    console.error('[cross-listing/search]', e.message);
    return send(res, 502, { ok: false, error: e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'Alias took too long — try again.' : 'Could not reach Alias.' });
  }
}
