// POST /api/images/import  { sku, picks: [{ angle, url }] } -> { ok, results }
// PH "Image Finder" step 2: take the StockX frame URLs the user picked, fetch the
// bytes SERVER-SIDE (SSRF-guarded to images.stockx.com), re-upload them to R2, and
// record each as a source='ph_edited' listing photo for the SKU — so they become
// the listing images/thumbnail just like a hand-edited upload. Reuses the same R2
// key layout and setProductPhoto as /api/photos/*.
import { send, applySecurity, rateLimit, requireRole, getJsonBody, cleanSku, fetchWithTimeout } from '../_lib/util.js';
import { setProductPhoto, dbConfigured } from '../_lib/db.js';
import { r2Configured, presignPutUrl, publicUrl } from '../_lib/r2.js';
import { isAllowedSourceImageUrl } from '../_lib/kicksdb.js';
import { photoSourceForRole, PHOTO_ANGLES, PH_EXTRA_ANGLES } from '../_lib/photos.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };
const ALLOWED_ANGLES = [...PHOTO_ANGLES, ...PH_EXTRA_ANGLES];
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per image — StockX renders are well under this
const MAX_PICKS = 7;               // the 5 slots we auto-fill, with headroom

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'Photo storage is not configured (R2 env vars missing).' });

  // These photos are stored exactly like PH edited photos.
  const source = photoSourceForRole(user.role, 'ph_edited');
  if (!source) return send(res, 403, { ok: false, error: 'You can’t manage that photo set.' });

  const body = await getJsonBody(req);
  const sku = normSku(body.sku);
  if (!sku) return send(res, 400, { ok: false, error: 'A valid SKU is required.' });
  const picks = Array.isArray(body.picks) ? body.picks.slice(0, MAX_PICKS) : [];
  if (!picks.length) return send(res, 400, { ok: false, error: 'Pick at least one image.' });

  const safeSku = sku.replace(/[^A-Za-z0-9._-]/g, '_');
  const createdBy = user.name || user.username || '';

  // Import one pick: fetch the StockX bytes → R2 → record. Never throws; always
  // resolves to a per-angle result so one failure can't sink the others.
  async function importOne(pick) {
    const angle = ALLOWED_ANGLES.includes(pick?.angle) ? pick.angle : null;
    const url = String(pick?.url || '');
    if (!angle) return { angle: pick?.angle || null, ok: false, error: 'Invalid angle.' };
    // SSRF guard: only fetch from the StockX / GOAT image CDNs.
    if (!isAllowedSourceImageUrl(url)) return { angle, ok: false, error: 'Image URL is not on the allowed host.' };
    try {
      const resp = await fetchWithTimeout(url, { headers: { accept: 'image/*' } }, 15000);
      if (!resp.ok) return { angle, ok: false, error: `Source returned ${resp.status}.` };
      const ct = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = EXT[ct];
      if (!ext) return { angle, ok: false, error: `Unsupported image type (${ct || 'unknown'}).` };
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) return { angle, ok: false, error: 'Image is empty or too large.' };

      const key = `listings/${safeSku}/${source}/${angle}-${Date.now()}.${ext}`;
      const uploadUrl = presignPutUrl({ key, expiresIn: 300 });
      const put = await fetchWithTimeout(uploadUrl, { method: 'PUT', headers: { 'Content-Type': ct }, body: buf }, 20000);
      if (!put.ok) return { angle, ok: false, error: `Upload failed (${put.status}).` };

      const pub = publicUrl(key);
      await setProductPhoto({ sku, angle, url: pub, source, createdBy });
      return { angle, ok: true, url: pub };
    } catch (e) {
      console.error('[images/import]', angle, e.message);
      return { angle, ok: false, error: 'Could not import this image.' };
    }
  }

  // Run all picks concurrently — cuts wall-clock time and stops a slow later
  // image from being starved behind the earlier ones.
  const results = await Promise.all(picks.map(importOne));
  const saved = results.filter((r) => r.ok).length;
  return send(res, 200, { ok: saved > 0, saved, results });
}
