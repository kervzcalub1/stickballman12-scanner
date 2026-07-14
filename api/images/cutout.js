// POST /api/images/cutout { sku, url }  (ph_team)
// Cut a shoe out of its background for the live "position & resize" editor: fetch the
// source render (GOAT/StockX) or a PH upload, run the cutout provider, upload the
// transparent PNG to R2, and return its URL + the shoe's alpha bounding box + size.
// The editor draws that exact PNG; Brand & Fill then reuses it (precut) so what PH
// positions is exactly what renders. See docs/context/ph-report.md.
import { send, applySecurity, rateLimit, requireRole, getJsonBody, cleanSku, fetchWithTimeout } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { r2Configured, presignPutUrl, publicUrl, isAllowedPhotoUrl } from '../_lib/r2.js';
import { isAllowedSourceImageUrl, hiResSourceUrl } from '../_lib/kicksdb.js';
import { cutoutForEdit } from '../_lib/branding.js';
import { photoSourceForRole } from '../_lib/photos.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };
const MAX_BYTES = 12 * 1024 * 1024;
const fetchable = (url) => isAllowedSourceImageUrl(url) || isAllowedPhotoUrl(url);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'Photo storage is not configured (R2 env vars missing).' });
  if (!photoSourceForRole(user.role, 'ph_edited')) return send(res, 403, { ok: false, error: 'You can’t manage that photo set.' });

  const body = await getJsonBody(req);
  const sku = normSku(body.sku);
  if (!sku) return send(res, 400, { ok: false, error: 'A valid SKU is required.' });
  const url = String(body.url || '');
  if (!fetchable(url)) return send(res, 400, { ok: false, error: 'Image URL is not on an allowed host.' });
  const safeSku = sku.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_');

  try {
    // A PH upload is already on our R2 host at full size; only marketplace renders
    // get the /original/ hi-res swap.
    const src = isAllowedPhotoUrl(url) ? url : hiResSourceUrl(url);
    const resp = await fetchWithTimeout(src, { headers: { accept: 'image/*' } }, 15000);
    if (!resp.ok) return send(res, 502, { ok: false, error: `Source returned ${resp.status}.` });
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return send(res, 400, { ok: false, error: 'Image is empty or too large.' });

    const { pngBuffer, bbox, width, height } = await cutoutForEdit(buf);
    const key = `listings/${safeSku}/_cut/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const put = await fetchWithTimeout(presignPutUrl({ key, expiresIn: 300 }),
      { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: pngBuffer }, 20000);
    if (!put.ok) return send(res, 502, { ok: false, error: 'Could not stage the cutout.' });

    return send(res, 200, { ok: true, cutoutUrl: publicUrl(key), bbox, width, height });
  } catch (e) {
    console.error('[images/cutout]', e.message);
    const throttled = e.throttled || /\b429\b|rate|throttl/i.test(e.message || '');
    if (throttled) return send(res, 503, { ok: false, error: 'Background remover is rate-limited (Replicate < $5 credit). Wait a moment and try again.' });
    return send(res, 500, { ok: false, error: 'Could not cut out the shoe. Try again.' });
  }
}
