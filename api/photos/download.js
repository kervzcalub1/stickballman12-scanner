// GET /api/photos/download?sku=... -> binary
// Downloads a SKU's listing photos: a single image if there's only one, otherwise
// a .zip of all angles. Fetches the (public R2) photo URLs server-side so the
// browser never needs CORS/credentials on the bucket. Warehouse + PH + admin.
import { applySecurity, rateLimit, requireRole, cleanSku, send } from '../_lib/util.js';
import { listProductPhotos, dbConfigured } from '../_lib/db.js';
import { makeZip } from '../_lib/zip.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const extFor = (ct, url) => EXT[ct] || (String(url).match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i)?.[0].replace(/\?.*$/, '') || '.jpg');
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-');

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const sku = normSku(new URL(req.url, 'http://x').searchParams.get('sku'));
  if (!sku) return send(res, 400, { ok: false, error: 'A SKU is required.' });

  try {
    const photos = await listProductPhotos(sku); // [{ angle, url }]
    if (!photos.length) return send(res, 404, { ok: false, error: 'No photos for this SKU.' });

    const fetched = [];
    for (const p of photos) {
      try {
        const r = await fetch(p.url);
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const ext = extFor(r.headers.get('content-type'), p.url);
        fetched.push({ angle: p.angle, buf, ext, ct: r.headers.get('content-type') || 'application/octet-stream' });
      } catch { /* skip a photo that won't fetch */ }
    }
    if (!fetched.length) return send(res, 502, { ok: false, error: 'Could not fetch the photos.' });

    if (fetched.length === 1) {
      const f = fetched[0];
      res.statusCode = 200;
      res.setHeader('Content-Type', f.ct);
      res.setHeader('Content-Disposition', `attachment; filename="${safe(sku)}-${safe(f.angle)}${f.ext}"`);
      res.setHeader('Content-Length', f.buf.length);
      return res.end(f.buf);
    }

    const zip = makeZip(fetched.map((f) => ({ name: `${safe(sku)}-${safe(f.angle)}${f.ext}`, data: f.buf })));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safe(sku)}-photos.zip"`);
    res.setHeader('Content-Length', zip.length);
    return res.end(zip);
  } catch (e) {
    console.error('[photos/download]', e.message);
    return send(res, 500, { ok: false, error: 'Could not build the download.' });
  }
}
