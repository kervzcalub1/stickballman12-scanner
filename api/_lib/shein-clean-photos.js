// SHEIN Listings → clean photos (2026-11-14): the I/O half (pure half: src/lib/sheinCleanPhotos.js).
//   • renderClean(buf)   — a transparent cutout → the shoe trimmed and centred on WHITE, 1500 × 1500 JPEG
//                          (what SHEIN gets; SHEIN wants a white main photo with nothing printed on it).
//   • findCleanPhotos()  — a style branded before the brand tool recorded its cutouts: list R2
//                          listings/<sku>/_cut/, then match every cutout to the uploaded branded photo of
//                          each angle by its picture (see matchScores), with the R2 timestamps as a fallback.
//   • photoSigs()        — 16 × 16 grey signatures (cached per photo) → which Shopify photos are copies of
//                          the PH set's spec / welcome slides.
// Never writes to R2. Every network read goes through an injectable function so tests stub it.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { listObjects, publicUrl, r2Configured } from './r2.js';
import { alphaBbox, fitShoeBox } from './branding.js';
import { productPhotosForSku, productCutoutsForSku, recordCutout, setCutoutShape, getListingCache, setListingCache } from './db.js';
import { recoverCutouts, cutoutPrefix, cutoutKeyTime, SHOE_ANGLES, SIG_N, matchPhCopies, viewOf } from '../../src/lib/sheinCleanPhotos.js';
import { photoKey, isShopifyPhoto } from '../../src/lib/sheinPublish.js';

const defaultLoad = async (url) => (await import('./shein-publish.js')).fetchImage(url);

/* --------------------------------- render on white --------------------------------- */
export const CLEAN_RENDER_VERSION = 'clean1500-white-trim-v1';
// Trim the cutout to its shoe (alpha > 12), fit it in 86 % of a 1500 × 1500 white square, centred, JPEG 90.
// An opaque picture (no transparency) is padded the same way, never cropped. Under 600 px long → refused.
export async function renderClean(buf, { size = 1500, fill = 0.86 } = {}) {
  const img = await loadImage(buf);
  const box = alphaBbox(img);
  if (Math.max(box.w, box.h) < 300) throw Object.assign(new Error(`shoe too small in the cutout (${box.w}×${box.h})`), { tooSmall: true });
  const c = createCanvas(size, size); const g = c.getContext('2d');
  g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, size, size);
  const k = Math.min((size * fill) / box.w, (size * fill) / box.h);
  const w = Math.round(box.w * k); const h = Math.round(box.h * k);
  g.drawImage(img, box.x, box.y, box.w, box.h, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
  return c.encode('jpeg', 90);
}

/* --------------------------------- match cutouts to the branded set --------------------------------- */
const N = 200; const SCALE = 1600 / N;   // the brand templates are drawn in 1600-space
// Grey-free RGB at 200 × 200 of a branded photo.
async function brandedPixels(buf) {
  const img = await loadImage(buf);
  const c = createCanvas(N, N); const g = c.getContext('2d'); g.drawImage(img, 0, 0, N, N);
  return g.getImageData(0, 0, N, N).data;
}
// The shoe's box found on a quarter-size copy (a full-size scan of a 2,000 px PNG is the slow part) —
// a few px off at full size, nothing at the 200 px the comparison runs at.
function quickBbox(img) {
  const k = 4; const w = Math.max(1, Math.round(img.width / k)); const h = Math.max(1, Math.round(img.height / k));
  const c = createCanvas(w, h); const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let minX = w; let minY = h; let maxX = 0; let maxY = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 12) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX <= minX || maxY <= minY) return { x: 0, y: 0, w: img.width, h: img.height };
  const sx = img.width / w; const sy = img.height / h;
  return { x: Math.floor(minX * sx), y: Math.floor(minY * sy), w: Math.ceil((maxX - minX + 1) * sx), h: Math.ceil((maxY - minY + 1) * sy) };
}
// The cutout placed where Brand & Fill puts it by default (fitShoeBox), at 200 × 200, with its alpha
// (+ its shape: the decode is the slow part, so it is measured here too → .shape on the pixel array).
async function placedCutout(buf) {
  const img = await loadImage(buf); const bb = quickBbox(img); const pl = fitShoeBox(bb);
  const shape = await shapeOf(img).catch(() => null);
  const c = createCanvas(N, N); const g = c.getContext('2d');
  g.drawImage(img, bb.x, bb.y, bb.w, bb.h, pl.dx / SCALE, pl.dy / SCALE, pl.dw / SCALE, pl.dh / SCALE);
  const px = g.getImageData(0, 0, N, N).data;
  px.shape = shape;
  return px;
}
// What the cutout SHOWS, from its silhouette (2026-11-14; read by `viewOf`, src/lib/sheinCleanPhotos.js): measured
// on a quarter-size copy — ar, fill, the mean gaps over / under the shoe (topM / botM, middle 70 % of its
// width) and the empty columns inside its box (gap: two shoes side by side). → { ar, fill, topM, botM, gap }
export async function shapeOf(bufOrImg) {
  const img = bufOrImg?.width ? bufOrImg : await loadImage(bufOrImg);
  const k = 4; const w = Math.max(1, Math.round(img.width / k)); const h = Math.max(1, Math.round(img.height / k));
  const c = createCanvas(w, h); const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const on = (x, y) => d[(y * w + x) * 4 + 3] > 128;
  let x0 = w; let x1 = -1; let y0 = h; let y1 = -1; let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) { n += 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1; const bh = y1 - y0 + 1;
  let top = 0; let bot = 0; let cols = 0; let gap = 0;
  for (let x = x0; x <= x1; x++) {
    let t = -1; let b = -1;
    for (let y = y0; y <= y1; y++) if (on(x, y)) { if (t < 0) t = y; b = y; }
    if (t < 0) { gap += 1; continue; }
    if (x >= x0 + Math.round(bw * 0.15) && x <= x1 - Math.round(bw * 0.15)) { top += (t - y0) / bh; bot += (y1 - b) / bh; cols += 1; }
  }
  const r = (v, p = 3) => Math.round(v * 10 ** p) / 10 ** p;
  return { ar: r(bw / bh, 2), fill: r(n / (bw * bh), 2), topM: cols ? r(top / cols) : 0, botM: cols ? r(bot / cols) : 0, gap };
}

// How far a placed cutout is from a branded photo, over the shoe's own pixels (mean |Δ| per channel).
// Measured 2026-11-14: the cutout a branded photo was made from scores 2–14; any other angle ≥ 25. A shoe
// PH moved / resized on the canvas scores high against everything (then the timestamps decide).
export function cutoutScore(cut, branded) {
  let t = 0; let n = 0;
  for (let i = 0; i < cut.length; i += 4) {
    if (cut[i + 3] <= 230) continue;
    t += Math.abs(cut[i] - branded[i]) + Math.abs(cut[i + 1] - branded[i + 1]) + Math.abs(cut[i + 2] - branded[i + 2]); n += 1;
  }
  return n ? t / n / 3 : Infinity;
}
export const MATCH_MAX = 18;

// Pure: pick a cutout per angle from the score matrix, falling back to the timestamp recovery.
//   angles: ['side', …] (the uploaded shoe angles), cuts: [{ url, ts }], scores[a][c] (angle × cutout),
//   ts: recoverCutouts(...) → [{ url, angle, takenAt, how: 'checked' | 'timestamp' }]
export function assignCutouts(angles, cuts, scores, ts) {
  const out = []; const used = new Set();
  angles.forEach((angle, a) => {
    let best = -1;
    cuts.forEach((c, j) => { const s = scores[a]?.[j]; if (s <= MATCH_MAX && (best < 0 || s < scores[a][best] - 0.5 || (Math.abs(s - scores[a][best]) <= 0.5 && c.ts > cuts[best].ts))) best = j; });
    if (best >= 0) { out.push({ url: cuts[best].url, angle, takenAt: cuts[best].ts, how: 'checked' }); used.add(cuts[best].url); }
  });
  const checked = new Map(out.map((x) => [x.angle, x.url]));
  // the timestamps only count when they agree with every picture match (else they're wrong for this style)
  const agrees = ts.confidence === 'exact' && ts.photos.every((p) => !checked.has(p.angle) || checked.get(p.angle) === p.url);
  if (agrees) for (const p of ts.photos) if (!checked.has(p.angle) && !used.has(p.url)) out.push({ url: p.url, angle: p.angle, takenAt: p.takenAt, how: 'timestamp' });
  return out.sort((x, y) => SHOE_ANGLES.indexOf(x.angle) - SHOE_ANGLES.indexOf(y.angle));
}

// Find (and with `write`, record) a style's clean photos on R2. → { sku, cutouts, found: [...], recorded, confidence, why }
//   list(prefix) → [{ key }] · load(url) → Buffer — injectable (tests never reach R2).
export async function findCleanPhotos(sku, { write = false, by = null, list = null, load = defaultLoad, maxCutouts = 20 } = {}) {
  const style = String(sku || '').trim();
  if (!style) return { sku: style, cutouts: 0, found: [], recorded: 0, confidence: 'none', why: 'no_sku' };
  const lister = list || ((prefix) => (r2Configured() ? listObjects(prefix) : Promise.resolve([])));
  const keys = await lister(cutoutPrefix(style));
  const cuts = keys.map((k) => ({ url: k.url || publicUrl(k.key), ts: cutoutKeyTime(k.key || k.url) })).filter((c) => c.ts).sort((a, b) => a.ts - b.ts);
  const ph = (await productPhotosForSku(style, 'ph_edited')).filter((p) => SHOE_ANGLES.includes(p.angle));
  const ts = recoverCutouts({ cutouts: cuts, ph: ph.map((p) => ({ angle: p.angle, at: new Date(p.created_at).getTime() })) });
  if (!ph.length || !cuts.length) return { sku: style, cutouts: cuts.length, found: [], recorded: 0, confidence: 'none', why: ts.why };
  // only cutouts staged before the upload can be in it; the newest `maxCutouts` of them
  const start = Math.min(...ph.map((p) => new Date(p.created_at).getTime()));
  const cand = cuts.filter((c) => c.ts < start).slice(-maxCutouts);
  // a few at a time (each is a download + a decode)
  const pool = async (items, fn, n = 4) => { const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]).catch(() => null); } }));
    return out; };
  const branded = await pool(ph, async (p) => brandedPixels(await load(p.url)));
  const placed = await pool(cand, async (c) => placedCutout(await load(c.url)));
  const scores = ph.map((_, a) => cand.map((_, j) => (branded[a] && placed[j] ? cutoutScore(placed[j], branded[a]) : Infinity)));
  const found = assignCutouts(ph.map((p) => p.angle), cand, scores, ts);
  for (const f of found) { const shape = placed[cand.findIndex((c) => c.url === f.url)]?.shape || null; f.shape = shape; f.view = viewOf(shape); }
  let recorded = 0;
  if (write) for (const f of found) if (await recordCutout({ sku: style, angle: f.angle, url: f.url, origin: 'recovered', how: f.how, takenAt: f.takenAt, createdBy: by, shape: f.shape })) recorded += 1;
  const confidence = !found.length ? 'none' : found.every((f) => f.how === 'checked') ? 'checked' : 'mixed';
  return { sku: style, cutouts: cuts.length, angles: ph.length, found, recorded, confidence, why: ts.why };
}

/* --------------------------------- photo signatures --------------------------------- */
// A 16 × 16 grey block average of a photo (exact box average over every pixel — a plain canvas downscale
// aliases the brick pattern and two copies of one photo stop matching).
export async function imageSig(buf) {
  const img = await loadImage(buf);
  const scale = Math.min(1, 400 / Math.max(img.width, img.height));   // ≤ 400 px is plenty for 16 × 16 blocks
  const w = Math.max(SIG_N, Math.round(img.width * scale)); const h = Math.max(SIG_N, Math.round(img.height * scale));
  const c = createCanvas(w, h); const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const s = new Float64Array(SIG_N * SIG_N); const n = new Float64Array(SIG_N * SIG_N);
  for (let y = 0; y < h; y++) {
    const row = Math.floor((y * SIG_N) / h) * SIG_N;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const k = row + Math.floor((x * SIG_N) / w); s[k] += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; n[k] += 1; }
  }
  return Array.from(s, (v, k) => Math.round((v / (n[k] || 1)) * 10) / 10);
}
// Shopify's CDN resizes on request (?width=) — a small copy is enough for a signature.
export const sigUrl = (url) => (isShopifyPhoto(url) ? `${url}${String(url).includes('?') ? '&' : '?'}width=400` : url);
// Signatures for many photos, cached per photo key (shein_listing_cache kind 'photo_sig'). A photo that
// can't be read is left out of the answer. `deadline` (ms epoch) stops reading new photos.
export async function photoSigs(urls, { load = defaultLoad, deadline = Infinity } = {}) {
  const out = new Map();
  for (const url of urls) {
    const key = photoKey(url);
    if (!key || out.has(key)) continue;
    const hit = await getListingCache('photo_sig', key).catch(() => null);
    if (Array.isArray(hit?.payload?.sig)) { out.set(key, hit.payload.sig); continue; }
    if (Date.now() > deadline) continue;
    try {
      const sig = await imageSig(await load(sigUrl(url)));
      await setListingCache('photo_sig', key, { sig, at: new Date().toISOString() }, 'clean photos');
      out.set(key, sig);
    } catch { /* unreadable → not judged */ }
  }
  return out;
}
// Which of a shoe's Shopify photos are copies of its PH photos (and so of the spec / welcome slide).
//   shopifyUrls, ph: [{ angle, url }] → { byKey: Map(key → { angle, slide, d }), checked: n of shopify read }
export async function shopifyPhCopies(shopifyUrls, ph, { load = defaultLoad, deadline = Infinity } = {}) {
  const sigs = await photoSigs([...ph.map((p) => p.url), ...shopifyUrls], { load, deadline });
  const shop = shopifyUrls.map((u) => ({ key: photoKey(u), sig: sigs.get(photoKey(u)) })).filter((x) => x.sig);
  const phs = ph.map((p) => ({ angle: p.angle, sig: sigs.get(photoKey(p.url)) })).filter((x) => x.sig);
  return { byKey: matchPhCopies(shop, phs), checked: shop.length, phRead: phs.length };
}

// The clean photos of a style in slot order: [{ url, angle, origin, how, view, shape }].
export async function cleanPhotosFor(style) {
  return style ? (await productCutoutsForSku(style).catch(() => [])).map((r) => ({ url: r.url, angle: r.angle, origin: r.origin, how: r.how, view: r.shape ? viewOf(r.shape) : null, shape: r.shape || null })) : [];
}
// Measure the cutouts of a style recorded before shapes were (2026-11-14) — downloads only those, ≤ `deadline`.
// → the style's clean photos with their views. A cutout that can't be read stays unmeasured (never a side view).
export async function ensureShapes(style, { load = defaultLoad, deadline = Infinity } = {}) {
  const rows = await cleanPhotosFor(style);
  for (const r of rows) {
    if (r.shape || Date.now() > deadline) continue;
    try {
      r.shape = await shapeOf(await load(r.url)); r.view = viewOf(r.shape);
      await setCutoutShape(style, r.angle, r.shape);
    } catch { /* unreadable now → stays unmeasured */ }
  }
  return rows;
}
