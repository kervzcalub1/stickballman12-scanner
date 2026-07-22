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
import { kicksdbSpecData } from '../_lib/kicksdb.js';
import { nikeSpecData } from '../_lib/nike.js';
import { isAllowedSourceImageUrl, hiResSourceUrl } from '../_lib/imgsources.js';
import {
  brandPhoto, brandSpec, welcomeSlide, cutoutForEditMaybePreCut, specBulletsFromDescription,
  ANGLE_TEMPLATE,
} from '../_lib/branding.js';
import { cutoutProvider } from '../_lib/cutout.js';

import { photoSourceForRole, listingPhotoBaseName } from '../_lib/photos.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };
const MAX_BYTES = 12 * 1024 * 1024;
const PREVIEW_SIZE = 900; // review-grid resolution (final commit renders at the chosen size)
// Wall-clock budget for the whole job loop. Under a sustained Replicate throttle a single
// cutout can retry for ~2 min; without a cap a 5-shoe batch could run 10+ min in one HTTP
// request (gateway drops the connection, client gets nothing). Once exceeded, remaining
// jobs short-circuit to a "still busy, re-run" error instead of blocking.
const BRAND_BUDGET_MS = 100_000;
const fetchable = (url) => isAllowedSourceImageUrl(url) || isAllowedPhotoUrl(url);
const toDataUri = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;
const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  // Per-slide requests (the client renders/commits one slide at a time for progress),
  // so a normal preview+adjust+upload cycle is a dozen-plus calls — keep the cap well above that.
  if (!rateLimit(req, { windowMs: 60_000, max: 80 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'Photo storage is not configured (R2 env vars missing).' });
  const source = photoSourceForRole(user.role, 'ph_edited');
  if (!source) return send(res, 403, { ok: false, error: 'You can’t manage that photo set.' });

  const body = await getJsonBody(req);
  const sku = normSku(body.sku);
  if (!sku) return send(res, 400, { ok: false, error: 'A valid SKU is required.' });
  const title = String(body.title || '').trim().slice(0, 120) || sku;
  // Neutralize anything outside a safe key charset AND collapse `..` runs (defense-in-depth
  // for the R2 key, even though R2 keys are a flat namespace with no traversal semantics).
  const safeSku = sku.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
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
    // `<sku>-<position>-<angle>-<ts>.jpg` — same name PH downloads (see photos/download.js),
    // so a file in the bucket and a file in the zip are recognisably the same thing. The
    // timestamp stays: re-branding an angle must write a NEW key, or the public URL would be
    // unchanged and browsers/CDN would keep serving the previous image.
    const key = `listings/${safeSku}/ph_edited/${listingPhotoBaseName(sku, angle)}-${Date.now()}.jpg`;
    const put = await fetchWithTimeout(presignPutUrl({ key, expiresIn: 300 }),
      { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: buffer }, 20000);
    if (!put.ok) throw new Error(`upload ${put.status}`);
    const url = publicUrl(key);
    await setProductPhoto({ sku, angle, url, source, createdBy });
    return url;
  }

  const jobs = [];

  for (const pick of picks) {
    // Own-property lookup only — a plain-object bracket access would treat "__proto__" etc. as a valid angle.
    const angle = pick?.angle && Object.hasOwn(ANGLE_TEMPLATE, pick.angle) ? pick.angle : null;
    const url = String(pick?.url || '');
    // A "precut" pick reuses a staged cutout (from a preview / the canvas editor) and its exact
    // { dx,dy,dw,dh } placement — no re-cut, no re-fit. It must be THIS SKU's staged cutout on
    // our R2 host, not an arbitrary object under the bucket.
    const claimedPrecut = pick?.precut === true;
    const precut = claimedPrecut && isAllowedPhotoUrl(url) && url.includes(`/${safeSku}/_cut/`);
    // Validate all four transform fields and bound them: dx/dy may be 0/negative; dw/dh
    // must be > 0. Cap the magnitudes so an extreme scale can't hand a huge dimension to
    // the canvas scaler (the target canvas is fixed W×W, but the source-scale path still
    // shouldn't take an unbounded value from a non-admin caller).
    const inBounds = (v, lo, hi) => v != null && v >= lo && v <= hi;
    const t = pick?.transform && typeof pick.transform === 'object' ? pick.transform : null;
    const dx = numOrNull(t?.dx), dy = numOrNull(t?.dy), dw = numOrNull(t?.dw), dh = numOrNull(t?.dh);
    const transform = precut && inBounds(dx, -20000, 20000) && inBounds(dy, -20000, 20000)
      && inBounds(dw, 1, 20000) && inBounds(dh, 1, 20000) ? { dx, dy, dw, dh } : null;
    // A fresh pick runs the (throttle-prone) AI cutout; precut/spec/welcome jobs are cheap.
    jobs.push({ slot: angle || pick?.angle || null, heavy: !precut, run: async () => {
      if (!angle) return { slot: pick?.angle || null, ok: false, error: 'Invalid angle.' };
      if (claimedPrecut && !precut) return { slot: angle, ok: false, error: 'Cutout reference is not valid for this SKU.' };
      if (!fetchable(url)) return { slot: angle, ok: false, error: 'Image URL is not on an allowed host.' };
      try {
        let shoeBuffer, cutoutUrl = precut ? url : null, bbox = null;
        if (precut) {
          const resp = await fetchWithTimeout(url, { headers: { accept: 'image/*' } }, 15000);
          if (!resp.ok) return { slot: angle, ok: false, error: `Cutout returned ${resp.status}.` };
          shoeBuffer = Buffer.from(await resp.arrayBuffer());
          if (!shoeBuffer.length || shoeBuffer.length > MAX_BYTES) return { slot: angle, ok: false, error: 'Cutout is empty or too large.' };
        } else {
          // Fresh pick: pull the full-res GOAT rendition, cut it out ONCE, stage the PNG.
          const resp = await fetchWithTimeout(hiResSourceUrl(url), { headers: { accept: 'image/*' } }, 15000);
          if (!resp.ok) return { slot: angle, ok: false, error: `Source returned ${resp.status}.` };
          const srcBuf = Buffer.from(await resp.arrayBuffer());
          if (!srcBuf.length || srcBuf.length > MAX_BYTES) return { slot: angle, ok: false, error: 'Image is empty or too large.' };
          // Nike's renditions arrive already transparent — that path skips the AI matte
          // entirely; everything else still throws (no land-effect fallback) on failure.
          const cut = await cutoutForEditMaybePreCut(srcBuf);
          shoeBuffer = cut.pngBuffer; bbox = cut.bbox;
          cutoutUrl = await stageCutout(cut.pngBuffer);
        }
        const branded = await brandPhoto({ templateNum: ANGLE_TEMPLATE[angle], shoeBuffer, title, sku, outSize: renderSize, precut: true, transform });
        if (commit) return { slot: angle, ok: true, url: await storeFinal(angle, branded) };
        return { slot: angle, ok: true, preview: toDataUri(branded), cutoutUrl, bbox };
      } catch (e) {
        const provider = cutoutProvider();
        console.error('[images/brand] photo', angle, `provider=${provider}`, e.message);
        const throttled = e.throttled || /\b429\b|rate|throttl/i.test(e.message || '');
        // Surface the active provider (and, for a config problem, why) so a prod failure
        // is self-diagnosing instead of a generic "try again". If the provider resolved to
        // 'local' on prod, the token isn't taking effect (missing var or CUTOUT_PROVIDER=local).
        const misconfigured = provider !== 'replicate' && provider !== 'removebg';
        return { slot: angle, ok: false, throttled,
          error: throttled
            ? 'Background remover is rate-limited (Replicate < $5 credit). Wait a moment and re-run this shoe.'
            : misconfigured
              ? `No hosted background remover is active (provider="${provider}"). Set REPLICATE_API_TOKEN on the server and clear any CUTOUT_PROVIDER=local override.`
              : `Could not cut out this shoe via ${provider} — try again. (${String(e.message || '').slice(0, 120)})` };
      }
    } });
  }

  if (body.includeSpec) {
    jobs.push({ slot: 'spec', heavy: false, run: async () => {
      try {
        // Merge the two catalogues rather than picking one — they're good at different
        // things. Nike is authoritative for the FACTS we print verbatim (official
        // colourway naming and order, real product category). But its marketing copy is
        // shorter than GOAT's and often omits the upper material — e.g. for the Air
        // Jordan 1 only GOAT's prose says "leather" — so the keyword inference below
        // reads BOTH descriptions. Non-Nike SKUs just fall through to GOAT alone.
        const [nike, kicks] = await Promise.all([nikeSpecData(sku), kicksdbSpecData(sku)]);
        const description = [nike?.description, kicks?.description].filter(Boolean).join(' ');
        const colorway = nike?.colorway || kicks?.colorway || '';
        const bullets = specBulletsFromDescription(description, colorway, { subtitle: nike?.subtitle });
        const branded = await brandSpec({ title, sku, bullets, outSize: renderSize });
        if (commit) return { slot: 'spec', ok: true, url: await storeFinal('extra1', branded), bullets };
        return { slot: 'spec', ok: true, preview: toDataUri(branded), bullets };
      } catch (e) { console.error('[images/brand] spec', e.message); return { slot: 'spec', ok: false, error: 'Could not build the spec slide.' }; }
    } });
  }

  if (body.includeWelcome) {
    jobs.push({ slot: 'welcome', heavy: false, run: async () => {
      try {
        const branded = await welcomeSlide({ outSize: renderSize });
        if (commit) return { slot: 'welcome', ok: true, url: await storeFinal('extra2', branded) };
        return { slot: 'welcome', ok: true, preview: toDataUri(branded) };
      } catch (e) { console.error('[images/brand] welcome', e.message); return { slot: 'welcome', ok: false, error: 'Could not add the welcome slide.' }; }
    } });
  }

  // Sequentially — each AI cutout is CPU/network-bound; parallel jobs don't finish faster
  // and starve each other's I/O. (Only the fresh preview pass cuts; adjust/commit reuse.)
  // A wall-clock budget bails the rest once a throttle has eaten too much time, so the
  // client always gets a response (with partial results) instead of a dropped connection.
  const deadline = Date.now() + BRAND_BUDGET_MS;
  const results = [];
  for (const job of jobs) {
    // Only bail the throttle-prone cutout jobs once the budget is spent; the cheap
    // spec/welcome (and precut adjust/commit) jobs still run so they're never dropped.
    if (job.heavy && Date.now() > deadline) {
      results.push({ slot: job.slot, ok: false, throttled: true,
        error: 'Timed out waiting on the background remover (it may be rate-limited). Re-run the remaining shoes.' });
      continue;
    }
    results.push(await job.run());
  }
  const saved = results.filter((r) => r.ok).length;
  return send(res, 200, { ok: saved > 0, mode: commit ? 'commit' : 'preview', saved, results });
}
