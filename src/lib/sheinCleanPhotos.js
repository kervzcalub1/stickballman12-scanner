// SHEIN Listings → CLEAN photos (2026-11-14). Pure helpers, shared by the server and the page.
//
// SHEIN rejects the PH-branded listing photos (brick background, shoe name + style code, store logo:
// "watermark", "promotional information"), and the spec / welcome slides outright. The brand tool
// (api/images/brand.js) cuts every shoe out of its catalogue photo first and stages the transparent
// cutout on R2 at listings/<sku>/_cut/<ms>-<rand>.png — those cutouts, flattened on white, are the
// clean photos SHEIN gets. Going forward the brand tool's Upload records each one (`product_cutouts`,
// with its angle); for shoes branded before that, `recoverCutouts` works the angles out from the
// R2 timestamps (see docs/context/shein-listings.md → "Clean photos").

// The five shoe angles in listing order (= the brand tool's SLOTS) — photo 1 (main) is the side.
export const SHOE_ANGLES = ['side', 'diagonal', 'top', 'outsole', 'rear'];
// The PH set's two extra slides: extra1 = the spec list, extra2 = the welcome card. NEVER sent to SHEIN.
export const SLIDE_ANGLES = ['extra1', 'extra2'];
export const SLIDE_NAME = { extra1: 'spec', extra2: 'welcome' };
export const isSlideAngle = (a) => SLIDE_ANGLES.includes(String(a || ''));
export const ANGLE_LABEL = { side: 'side', diagonal: '3/4', top: 'top', outsole: 'sole', rear: 'heel', extra1: 'spec slide', extra2: 'welcome slide' };
const rank = (a) => { const i = SHOE_ANGLES.indexOf(a); return i < 0 ? SHOE_ANGLES.length : i; };

// The staging time (ms) in a cutout's key / URL: …/_cut/<ms>-<rand>.png → ms, else null.
export function cutoutKeyTime(urlOrKey) {
  const m = String(urlOrKey || '').split(/[?#]/)[0].match(/\/_cut\/(\d{12,14})-[a-z0-9]+\.png$/i);
  return m ? Number(m[1]) : null;
}
export const isCutoutUrl = (url) => cutoutKeyTime(url) != null;
// The R2 folder the brand tool uses for a SKU (same sanitising as brand.js / cutout.js).
export const cutoutPrefix = (sku) => `listings/${String(sku || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_')}/_cut/`;

// Clean photos in listing order: by angle (side first), an unknown angle after, then oldest first.
export function orderClean(rows) {
  return [...(rows || [])].sort((a, b) => rank(a.angle) - rank(b.angle) || (Number(a.takenAt ?? a.taken_at_ms ?? 0) - Number(b.takenAt ?? b.taken_at_ms ?? 0)));
}

// Which photos a SHEIN publish / photo replace uses. clean: null = automatic (clean when the style has
// any), false = a person switched them off, true = on. usePhPhotos = the older "Use PH edited photos".
// → 'clean' | 'ph_edited' | 'shopify'
export function photoSourceOf({ cleanPhotos = null, usePhPhotos = false, cleanCount = 0, phCount = 0 } = {}) {
  if (cleanPhotos !== false && Number(cleanCount) > 0) return 'clean';
  if (usePhPhotos && Number(phCount) > 0) return 'ph_edited';
  return 'shopify';
}

// Work out which staged cutouts made a SKU's branded set, and their angles, from timestamps alone.
//   cutouts: [{ url, ts }]  — everything under listings/<sku>/_cut/ (ts from the key)
//   ph:      [{ angle, at }] — the SKU's product_photos source='ph_edited' (at = created_at, ms)
// How the brand tool works (src/screens/ImageFinder.jsx): Brand & Fill stages one cutout per picked
// angle, one request at a time, in SHOE_ANGLES order; Upload re-renders from those staged cutouts and
// writes every angle within seconds. So the cutouts of the set are the LAST session of cutouts before
// the upload (a session = cutouts less than `gapMs` apart).
//   exact — that session holds exactly one cutout per uploaded angle and the upload was one go: the
//           n-th cutout is the n-th uploaded angle.
//   guess — something else happened in between (a re-cut of one shoe, a re-render, a failed cut, an
//           upload spread over time): the last n cutouts of the session are taken in order, but an
//           angle may be wrong — the page says "angles guessed", a person checks them.
//   none  — no uploaded shoe angle or no cutout before the upload.
// → { confidence, why, photos: [{ url, angle, takenAt }] }
export function recoverCutouts({ cutouts = [], ph = [], gapMs = 15 * 60_000, spreadMs = 10 * 60_000 } = {}) {
  const angles = ph.filter((x) => SHOE_ANGLES.includes(x.angle)).sort((a, b) => rank(a.angle) - rank(b.angle));
  const cuts = cutouts.filter((c) => Number.isFinite(Number(c.ts))).map((c) => ({ url: c.url, ts: Number(c.ts) })).sort((a, b) => a.ts - b.ts);
  if (!angles.length) return { confidence: 'none', why: cuts.length ? 'no_upload' : 'no_cutouts', photos: [] };
  const times = angles.map((x) => Number(x.at)).filter(Number.isFinite);
  const start = Math.min(...times); const spread = Math.max(...times) - start;
  const before = cuts.filter((c) => c.ts < start);
  if (!before.length) return { confidence: 'none', why: 'no_cutouts', photos: [] };
  const session = [before[before.length - 1]];
  for (let i = before.length - 2; i >= 0 && session[0].ts - before[i].ts <= gapMs; i--) session.unshift(before[i]);
  const n = angles.length;
  const take = session.slice(-n);
  const exact = session.length === n && spread <= spreadMs;
  const why = exact ? 'one_session' : spread > spreadMs ? 'upload_spread' : session.length > n ? 'extra_cutouts' : 'missing_cutouts';
  // fewer cutouts than angles: the first angles (side first) are the ones we can't place — the last
  // cutouts belong to the last angles
  const offset = n - take.length;
  return { confidence: exact ? 'exact' : 'guess', why, photos: take.map((c, i) => ({ url: c.url, angle: angles[offset + i].angle, takenAt: c.ts })) };
}

// Image signatures: a grey 16 × 16 block average (0–255 per block). Two copies of the same picture —
// our R2 original and Shopify's re-encoded, resized copy — differ by ~1 on average; two different
// photos of one shoe on the same brick template by ≥ 3.5 (measured on the PH sets, 2026-11-14).
export const SIG_N = 16;
export const SAME_PHOTO_MAX = 2;
export function sigDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let t = 0; for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]);
  return t / a.length;
}
// For each Shopify photo, the PH photo it is a copy of (nearest within SAME_PHOTO_MAX), if any.
//   shop: [{ key, sig }], ph: [{ angle, sig }] → Map(key → { angle, slide: 'spec'|'welcome'|null, d })
export function matchPhCopies(shop, ph) {
  const out = new Map();
  for (const s of shop || []) {
    let best = null;
    for (const p of ph || []) { const d = sigDistance(s.sig, p.sig); if (d <= SAME_PHOTO_MAX && (!best || d < best.d)) best = { angle: p.angle, d }; }
    if (best) out.set(s.key, { angle: best.angle, slide: SLIDE_NAME[best.angle] || null, d: Math.round(best.d * 100) / 100 });
  }
  return out;
}

/* ------------------------- the MAIN photo (2026-11-14, live Nike run) ------------------------- */
// The angle a cutout is filed under is only the brand-tool SLOT PH put it in — and PH often fills the slots
// in the catalogue's gallery order, not side / 3/4 / top / sole / heel (IF1721-300: the "3/4" slot holds
// the sole, the "sole" slot the inner side; 394055-101: the "side" slot holds a 3/4 pair). So what a
// picture SHOWS is read from the cutout's own silhouette (`shape`, measured on the server):
//   ar   width / height of the shoe        fill  share of that box the shoe covers
//   topM mean gap from the box top to the shoe's top edge (a side profile is low at the toe, high at
//        the collar → ~0.25–0.33; a sole / 3/4 / pair fills the top → ≤ 0.19)
//   botM mean gap under the shoe (a side profile stands on its sole → ≤ 0.02; a cleat's studs ~0.05)
//   gap  empty columns inside the box (two shoes next to each other — a top / heel pair)
// Measured on 50+ PH sets: 50 of 53 "side" slots pass (the 3 that don't: two high-tops at ar 1.6 —
// hence ar ≥ 1.45 — and one slot holding a 3/4 pair); every other slot that passes was checked by eye
// and IS a side view (the inner side, filed under another slot). A sole: wide, full top, dense.
export function viewOf(s) {
  if (!s || !Number.isFinite(Number(s.ar))) return null;
  // standing on its sole (≤ 0.035), or on studs (a cleat, ≤ 0.06) with a clearly side-on top edge (a single 3/4 shoe sits at 0.20–0.22)
  if (s.ar >= 1.45 && s.fill <= 0.71 && !s.gap && ((s.topM >= 0.2 && s.botM <= 0.035) || (s.topM >= 0.25 && s.botM <= 0.06))) return 'side';
  if (s.ar >= 2.4 && s.topM <= 0.11 && s.fill >= 0.76 && !s.gap) return 'sole';
  if (s.gap > 0) return 'pair';
  return null;
}
// How a cutout's filing was established: picture-matched to PH's uploaded photo of that slot, or recorded
// by the brand tool at Upload — vs only by the order it was cut ('timestamp').
export const CONFIRMED_HOW = ['checked', 'upload'];
const keyOf = (u) => String(u ?? '').split(/[?#]/)[0].trim();
// Photo 1 (SHEIN's main photo) of the clean set: a person's pick (mainKey) when it is still in the set,
// else a cutout whose own silhouette is a side view (`viewOf`) — PH's "side" slot when it is one (and its filing
// confirmed), then another confirmed slot that shows a side view, then one filed only by order whose picture
// is a side view. A cutout is NEVER the main on its slot label alone (labels follow PH's slots, which are often
// wrong). None → unsure: the shoe is held with "check the main photo", never sent on a guess.
// `skip` = photo keys left out (they can't be the main). `lenient` (the stored readiness, no download): a
// confirmed "side" slot whose shape isn't measured yet counts — the preview measures it before sending.
// rows: [{ url, angle, how, view }] → { rows: main first then the rest in slot order, main, unsure, why }
export function cleanOrder(rows, { mainKey = null, skip = [], lenient = false } = {}) {
  const out = new Set((skip || []).map(keyOf));
  const kept = orderClean(rows).filter((r) => !out.has(keyOf(r.url)));
  const confirmed = (r) => CONFIRMED_HOW.includes(r.how);
  let main = null; let why = null;
  if (mainKey) { main = kept.find((r) => keyOf(r.url) === keyOf(mainKey)) || null; if (main) why = 'person'; }
  if (!main) { main = kept.find((r) => r.angle === 'side' && confirmed(r) && (r.view === 'side' || (lenient && r.view == null))) || null; if (main) why = 'side_slot'; }
  if (!main) { main = kept.find((r) => confirmed(r) && r.view === 'side') || null; if (main) why = 'side_view'; }
  // filed only by order, but its own silhouette is a side view: the picture itself is checked, only PH's slot isn't
  if (!main) { main = kept.find((r) => r.view === 'side') || null; if (main) why = 'side_view_by_order'; }
  const rest = kept.filter((r) => r !== main);
  return { rows: main ? [main, ...rest] : kept, main, unsure: !!kept.length && !main, why };
}
