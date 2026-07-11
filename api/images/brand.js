// POST /api/images/brand { sku, title, picks:[{angle,url}], includeSpec, includeWelcome }
// PH "Brand & Fill": composite each picked shoe photo onto the Stickballman12
// template with the name + SKU, generate the spec slide, append the static welcome
// slide — then store each as a source='ph_edited' listing photo. Picks come from the
// GOAT/StockX gallery OR a PH upload already on our R2 host. Reuses the R2 key layout
// + setProductPhoto as the rest of /api/images/*.
import { send, applySecurity, rateLimit, requireRole, getJsonBody, cleanSku, fetchWithTimeout } from '../_lib/util.js';
import { setProductPhoto, dbConfigured } from '../_lib/db.js';
import { r2Configured, presignPutUrl, publicUrl, isAllowedPhotoUrl } from '../_lib/r2.js';
import { isAllowedSourceImageUrl, kicksdbSpecData, hiResSourceUrl } from '../_lib/kicksdb.js';
import {
  brandPhoto, brandSpec, welcomeSlide, specBulletsFromDescription,
  ANGLE_TEMPLATE, SPEC_TEMPLATE, WELCOME_TEMPLATE,
} from '../_lib/branding.js';
import { photoSourceForRole } from '../_lib/photos.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };
const MAX_BYTES = 12 * 1024 * 1024;
// A pick's source image may be a marketplace render (GOAT/StockX) or a PH upload
// already staged on our own R2 host — both are safe to fetch server-side.
const fetchable = (url) => isAllowedSourceImageUrl(url) || isAllowedPhotoUrl(url);

async function putJpegToR2(safeSku, angle) {
  const key = `listings/${safeSku}/ph_edited/${angle}-${Date.now()}.jpg`;
  return { key, uploadUrl: presignPutUrl({ key, expiresIn: 300 }) };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 12 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'Photo storage is not configured (R2 env vars missing).' });
  const source = photoSourceForRole(user.role, 'ph_edited');
  if (!source) return send(res, 403, { ok: false, error: 'You can’t manage that photo set.' });

  const body = await getJsonBody(req);
  const sku = normSku(body.sku);
  if (!sku) return send(res, 400, { ok: false, error: 'A valid SKU is required.' });
  const title = String(body.title || '').trim().slice(0, 120) || sku;
  const safeSku = sku.replace(/[^A-Za-z0-9._-]/g, '_');
  const createdBy = user.name || user.username || '';
  const picks = Array.isArray(body.picks) ? body.picks.slice(0, 5) : [];

  // Upload a branded JPEG buffer to R2 and record it against an angle.
  async function store(angle, buffer) {
    const { key, uploadUrl } = await putJpegToR2(safeSku, angle);
    const put = await fetchWithTimeout(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: buffer }, 20000);
    if (!put.ok) throw new Error(`upload ${put.status}`);
    const url = publicUrl(key);
    await setProductPhoto({ sku, angle, url, source, createdBy });
    return url;
  }

  const jobs = [];

  // Shoe angle slides → template 1..5, cut-out + name + SKU.
  for (const pick of picks) {
    const angle = ANGLE_TEMPLATE[pick?.angle] ? pick.angle : null;
    const url = String(pick?.url || '');
    jobs.push(async () => {
      if (!angle) return { slot: pick?.angle || null, ok: false, error: 'Invalid angle.' };
      if (!fetchable(url)) return { slot: angle, ok: false, error: 'Image URL is not on an allowed host.' };
      try {
        // Pull the full-res GOAT rendition (not the soft /medium/ gallery size).
        const resp = await fetchWithTimeout(hiResSourceUrl(url), { headers: { accept: 'image/*' } }, 15000);
        if (!resp.ok) return { slot: angle, ok: false, error: `Source returned ${resp.status}.` };
        const buf = Buffer.from(await resp.arrayBuffer());
        if (!buf.length || buf.length > MAX_BYTES) return { slot: angle, ok: false, error: 'Image is empty or too large.' };
        const branded = await brandPhoto({ templateNum: ANGLE_TEMPLATE[angle], shoeBuffer: buf, title, sku });
        const out = await store(angle, branded);
        return { slot: angle, ok: true, url: out };
      } catch (e) { console.error('[images/brand] photo', angle, e.message); return { slot: angle, ok: false, error: 'Could not brand this image.' }; }
    });
  }

  // Spec slide (extra1) — colorway from API + bullets from the description.
  if (body.includeSpec) {
    jobs.push(async () => {
      try {
        const spec = await kicksdbSpecData(sku);
        const bullets = specBulletsFromDescription(spec.description, spec.colorway);
        const branded = await brandSpec({ title, sku, bullets });
        const out = await store('extra1', branded);
        return { slot: 'spec', ok: true, url: out, bullets };
      } catch (e) { console.error('[images/brand] spec', e.message); return { slot: 'spec', ok: false, error: 'Could not build the spec slide.' }; }
    });
  }

  // Welcome slide (extra2) — static, no per-shoe text.
  if (body.includeWelcome) {
    jobs.push(async () => {
      try {
        const branded = await welcomeSlide();
        const out = await store('extra2', branded);
        return { slot: 'welcome', ok: true, url: out };
      } catch (e) { console.error('[images/brand] welcome', e.message); return { slot: 'welcome', ok: false, error: 'Could not add the welcome slide.' }; }
    });
  }

  // Run SEQUENTIALLY, not concurrently: each AI cutout is CPU-bound and saturates
  // the cores, so parallel jobs don't finish faster and their network I/O (R2 PUT,
  // spec lookup) gets starved past its timeout. One at a time keeps the loop healthy.
  const results = [];
  for (const job of jobs) results.push(await job());
  const saved = results.filter((r) => r.ok).length;
  return send(res, 200, { ok: saved > 0, saved, results });
}
