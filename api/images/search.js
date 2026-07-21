// GET /api/images/search?sku=DZ5485-612 -> { ok, configured, product, sources }
// PH "Image Finder": resolve a SKU against EVERY image source we have and return them
// all, so PH can pick the angle they want rather than being handed one catalogue's
// guess. Today that's KicksDB (GOAT gallery → StockX 360° → hero), Nike's own product
// feed, and the adidas studio set. The two brand sources LABEL their angles (Nike by
// view letter, adidas by filename), which is what makes a reliable top-down/outsole
// possible — GOAT has no top-down at all. Read-only; no bytes are stored here — the
// client picks angles, then POSTs /api/images/import.
import { send, applySecurity, rateLimit, requireRole, cleanSku } from '../_lib/util.js';
import { kicksdbConfigured, kicksdbImagesBySku } from '../_lib/kicksdb.js';
import { nikeImagesBySku } from '../_lib/nike.js';
import { adidasImagesBySku, warmAdidasIndex } from '../_lib/adidas.js';

// Start the adidas catalogue crawl at module load so the first PH search of the day
// isn't the one that pays for a cold index.
warmAdidasIndex();

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });

  const sku = normSku(new URL(req.url, 'http://x').searchParams.get('sku'));
  if (!sku) return send(res, 400, { ok: false, error: 'A valid SKU is required.' });

  try {
    // Query the sources concurrently — a slow catalogue shouldn't hold up the others.
    // Nike needs no API key, so a missing KICKSDB_KEY no longer fails the whole search:
    // it just means one fewer source. Both are best-effort and resolve to null on miss.
    const [kicks, nike, adidas] = await Promise.all([
      kicksdbConfigured() ? kicksdbImagesBySku(sku) : Promise.resolve(null),
      nikeImagesBySku(sku),
      adidasImagesBySku(sku),
    ]);

    // Brand-official sources lead: their angles are LABELLED (Nike by view letter,
    // adidas by filename), so their suggestions actually land in the right slots.
    // KicksDB stays as the fallback and the wider gallery. Only one brand source can
    // match a given code, so the order between them doesn't matter.
    const sources = [nike, adidas, kicks].filter(Boolean);
    if (!sources.length)
      return send(res, 200, { ok: true, configured: true, product: null, sources: [] });

    // `product` is the primary source, kept for backwards compatibility with the rest
    // of the flow (brand.js, the slot seeding); `sources` is the full set for the UI.
    return send(res, 200, { ok: true, configured: true, product: sources[0], sources });
  } catch (e) {
    console.error('[images/search]', e.message);
    return send(res, 502, { ok: false, error: 'Image lookup failed.' });
  }
}
