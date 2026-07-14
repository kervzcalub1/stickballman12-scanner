// POST /api/images/brand  (ph_team)
//   { sku, title, picks, includeSpec, includeWelcome, size, mode }
// PH "Brand & Fill" — two modes so PH can REVIEW before anything is saved:
//   • mode:'preview' (default) — cut each shoe out ONCE, stage the transparent PNG on R2,
//     composite it onto the template with name+SKU (+ spec + welcome), and return each slide
//     as a data-URI PREVIEW plus its cutoutUrl + bbox. Nothing is persisted to the photo set.
//   • mode:'commit' — the picks now carry the staged cutoutUrl (precut) + the size the PH
//     dialed in on the canvas; re-render at full resolution (NO re-cut) and persist to R2 +
//     product_photos(source='ph_edited').
// Flow: find image → angles → Brand & Fill (preview) → adjust on canvas → Upload (commit) →
// Download. See docs/context/ph-report.md.
import { send, applySecurity, rateLimit, requireRole, getJsonBody, cleanSku, fetchWithTimeout } from '../_lib/util.js';
import { setProductPhoto, dbConfigured } from '../_lib/db.js';
import { r2Configured, presignPutUrl, publicUrl, isAllowedPhotoUrl } from '../_lib/r2.js';
import { isAllowedSourceImageUrl, kicksdbSpecData, hiResSourceUrl } from '../_lib/kicksdb.js';
import {
  brandPhoto, brandSpec, welcomeSlide, cutoutForEdit, specBulletsFromDescription, ANGLE_TEMPLATE,
} from '../_lib/branding.js';
import { photoSourceForRole } from '../_lib/photos.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };
const MAX_BYTES = 12 * 1024 * 1024;
const PREVIEW_SIZE = 900; // review-grid resolution (final commit renders at the chosen size)
const fetchable = (url) => isAllowedSourceImageUrl(url) || isAllowedPhotoUrl(url);
const toDataUri = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;
const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
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
  const outSize = Number(body.size) === 1400 ? 1400 : 1600;
  const commit = body.mode === 'commit';
  const renderSize = commit ? outSize : PREVIEW_SIZE;

  // Stage a transparent cutout PNG on R2 so it can be reused (adjust + commit) without re-cutting.
  async function stageCutout(pngBuffer) {
    const key = `listings/${safeSku}/_cut/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const put = await fetchWithTimeout(presignPutUrl({ key, expiresIn: 300 }),
      { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: pngBuffer }, 20000);
    if (!put.ok) throw new Error(`cutout stage ${put.status}`);
    return publicUrl(key);
  }
  // Persist a finished slide (commit only) → R2 + product_photos.
  async function storeFinal(angle, buffer) {
    const key = `listings/${safeSku}/ph_edited/${angle}-${Date.now()}.jpg`;
    const put = await fetchWithTimeout(presignPutUrl({ key, expiresIn: 300 }),
      { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: buffer }, 20000);
    if (!put.ok) throw new Error(`upload ${put.status}`);
    const url = publicUrl(key);
    await setProductPhoto({ sku, angle, url, source, createdBy });
    return url;
  }

  const jobs = [];

  for (const pick of picks) {
    const angle = ANGLE_TEMPLATE[pick?.angle] ? pick.angle : null;
    const url = String(pick?.url || '');
    // A "precut" pick reuses a staged cutout (from a preview / the canvas editor) and its
    // exact { dx,dy,dw,dh } placement — no re-cut, no re-fit.
    const precut = pick?.precut === true && isAllowedPhotoUrl(url);
    const t = precut && pick?.transform && typeof pick.transform === 'object' ? pick.transform : null;
    const transform = t && numOrNull(t.dw) && numOrNull(t.dh)
      ? { dx: Number(t.dx), dy: Number(t.dy), dw: Number(t.dw), dh: Number(t.dh) } : null;
    jobs.push(async () => {
      if (!angle) return { slot: pick?.angle || null, ok: false, error: 'Invalid angle.' };
      if (!fetchable(url)) return { slot: angle, ok: false, error: 'Image URL is not on an allowed host.' };
      try {
        let shoeBuffer, cutoutUrl = precut ? url : null, bbox = null;
        if (precut) {
          const resp = await fetchWithTimeout(url, { headers: { accept: 'image/*' } }, 15000);
          if (!resp.ok) return { slot: angle, ok: false, error: `Cutout returned ${resp.status}.` };
          shoeBuffer = Buffer.from(await resp.arrayBuffer());
        } else {
          // Fresh pick: pull the full-res GOAT rendition, cut it out ONCE, stage the PNG.
          const resp = await fetchWithTimeout(hiResSourceUrl(url), { headers: { accept: 'image/*' } }, 15000);
          if (!resp.ok) return { slot: angle, ok: false, error: `Source returned ${resp.status}.` };
          const srcBuf = Buffer.from(await resp.arrayBuffer());
          if (!srcBuf.length || srcBuf.length > MAX_BYTES) return { slot: angle, ok: false, error: 'Image is empty or too large.' };
          const cut = await cutoutForEdit(srcBuf);   // throws (no land-effect fallback) if the AI cutout fails
          shoeBuffer = cut.pngBuffer; bbox = cut.bbox;
          cutoutUrl = await stageCutout(cut.pngBuffer);
        }
        const branded = await brandPhoto({ templateNum: ANGLE_TEMPLATE[angle], shoeBuffer, title, sku, outSize: renderSize, precut: true, transform });
        if (commit) return { slot: angle, ok: true, url: await storeFinal(angle, branded) };
        return { slot: angle, ok: true, preview: toDataUri(branded), cutoutUrl, bbox };
      } catch (e) {
        console.error('[images/brand] photo', angle, e.message);
        const throttled = e.throttled || /\b429\b|rate|throttl/i.test(e.message || '');
        return { slot: angle, ok: false, throttled,
          error: throttled
            ? 'Background remover is rate-limited (Replicate < $5 credit). Wait a moment and re-run this shoe.'
            : 'Could not cut out this shoe — try again.' };
      }
    });
  }

  if (body.includeSpec) {
    jobs.push(async () => {
      try {
        const spec = await kicksdbSpecData(sku);
        const bullets = specBulletsFromDescription(spec.description, spec.colorway);
        const branded = await brandSpec({ title, sku, bullets, outSize: renderSize });
        if (commit) return { slot: 'spec', ok: true, url: await storeFinal('extra1', branded), bullets };
        return { slot: 'spec', ok: true, preview: toDataUri(branded), bullets };
      } catch (e) { console.error('[images/brand] spec', e.message); return { slot: 'spec', ok: false, error: 'Could not build the spec slide.' }; }
    });
  }

  if (body.includeWelcome) {
    jobs.push(async () => {
      try {
        const branded = await welcomeSlide({ outSize: renderSize });
        if (commit) return { slot: 'welcome', ok: true, url: await storeFinal('extra2', branded) };
        return { slot: 'welcome', ok: true, preview: toDataUri(branded) };
      } catch (e) { console.error('[images/brand] welcome', e.message); return { slot: 'welcome', ok: false, error: 'Could not add the welcome slide.' }; }
    });
  }

  // Sequentially — each AI cutout is CPU/network-bound; parallel jobs don't finish faster
  // and starve each other's I/O. (Only the fresh preview pass cuts; adjust/commit reuse.)
  const results = [];
  for (const job of jobs) results.push(await job());
  const saved = results.filter((r) => r.ok).length;
  return send(res, 200, { ok: saved > 0, mode: commit ? 'commit' : 'preview', saved, results });
}
