// Nike product-feed client — a SECOND image source for the PH "Image Finder",
// shown alongside the KicksDB (GOAT/StockX) results so PH can pick the angle they
// want. No API key: api.nike.com/product_feed/threads/v2 is open, and it filters
// directly on the style code (styleColor), which is exactly our SKU format.
//
// Why it's worth a dedicated source: Nike tags every image with a `view` LETTER, so
// angles are LABELLED rather than guessed from a gallery index. That's what finally
// gives us a reliable top-down and outsole — a horizontal 360° spin has neither, and
// GOAT's gallery ordering is only stable at the front of the run.
//
// The letter→angle map below was verified by eye across three unrelated silhouettes
// (Alphafly 3 FD8311-401, Air Force 1 CW2288-111, Air Jordan 1 DZ5485-612): B was the
// outsole and D the top-down in all three. Covers Nike AND Jordan (same channel; the
// feed reports brand='Jordan'), but NOT adidas/New Balance/Reebok — different brands
// need their own module.
import { fetchWithTimeout } from './util.js';

const FEED = 'https://api.nike.com/product_feed/threads/v2';
// Nike's US/en consumer channel. Required — the feed 400s without a channel filter.
const CHANNEL_ID = 'd9a5bc42-4b9c-4976-858a-f159cf99c647';
export const NIKE_IMG_HOST = 'static.nike.com';

// Named Cloudinary preset. Use the presets, NOT an arbitrary `w_` transform:
// t_default/w_3000,c_limit silently returns a 400×400 thumbnail, while
// t_PDP_1920_v1 really is 1920×1920 (verified).
const RENDITION = 't_PDP_1920_v1';
// The SAME asset without Nike's grey-background transform comes back as a genuine
// pre-cut RGBA PNG (verified: 1728×1728, corner alpha 0, ~77% fully transparent).
// Brand & Fill can composite that straight onto the template — no AI background
// removal, so no Replicate call, no throttling, and no matte artefacts.
const CUTOUT_RENDITION = 'w_1728';

// view letter → our photo angle. Only the five letters we can place are mapped; the
// rest (C medial, H/K/P/Q/Z lifestyle + detail shots) still reach the UI as gallery
// images, they just don't auto-fill a slot.
const VIEW_ANGLE = { A: 'side', B: 'outsole', D: 'top', E: 'diagonal', F: 'rear' };
const VIEW_LABEL = {
  A: 'Lateral', B: 'Outsole', C: 'Medial', D: 'Top-down',
  E: '3/4 pair', F: 'Heel', H: 'Detail', K: 'Detail', P: 'Lifestyle', Q: 'Lifestyle', Z: 'Lifestyle',
};
// Order the gallery so the placeable angles lead and the lifestyle shots trail.
const VIEW_ORDER = ['A', 'C', 'E', 'D', 'B', 'F'];

// Nike needs no key — always available. Kept as a function to mirror kicksdbConfigured()
// so search.js can treat the two sources uniformly.
export function nikeConfigured() { return true; }

const hostIs = (url, host) => {
  try {
    const u = new URL(String(url));
    // Pin protocol, host AND default port — same rigor as kicksdb.js / r2.isAllowedPhotoUrl.
    return u.protocol === 'https:' && u.port === '' && u.hostname.toLowerCase() === host;
  } catch { return false; }
};
export const isNikeImageUrl = (url) => hostIs(url, NIKE_IMG_HOST);

const imageUrl = (id) => `https://${NIKE_IMG_HOST}/a/images/${RENDITION}/${id}/image.jpg`;

// Swap a gallery URL for its transparent-PNG twin (same asset id, no bg transform).
// Returns the input unchanged for any non-Nike host.
export function nikeCutoutUrl(url) {
  const s = String(url || '');
  if (!isNikeImageUrl(s)) return s;
  return s.replace(`/a/images/${RENDITION}/`, `/a/images/${CUTOUT_RENDITION}/`).replace(/\/image\.jpg$/, '/image.png');
}

// Nike style codes are `AA0000-000`. Anything else (an adidas article code, a GOAT
// slug) can't match, so skip the round-trip entirely.
const NIKE_STYLE_CODE = /^[A-Z]{2}\d{4}-\d{3}$|^\d{6}-\d{3}$/i;
export const looksLikeNikeSku = (sku) => NIKE_STYLE_CODE.test(String(sku || '').trim());

// Walk the thread graph collecting the first image id per view letter. The feed nests
// images several levels down and repeats each view (square + portrait crops), so
// first-wins per letter keeps one canonical shot each.
function collectViews(node, out = {}) {
  if (Array.isArray(node)) { for (const n of node) collectViews(n, out); return out; }
  if (!node || typeof node !== 'object') return out;
  const { view, id, type } = node;
  if (typeof view === 'string' && type === 'product' && id && !out[view]) out[view] = id;
  for (const v of Object.values(node)) collectViews(v, out);
  return out;
}

// One feed round-trip per SKU, shared by the image and spec lookups. Cached for the
// life of the process: the Image Finder asks for images and specs on the same SKU
// within a second of each other, and the feed is an undocumented endpoint we'd rather
// hit once. Best-effort — every failure caches/returns null.
const threadCache = new Map();
async function fetchThread(code) {
  if (threadCache.has(code)) return threadCache.get(code);

  const qs = new URLSearchParams();
  qs.append('anchor', '0');
  qs.append('count', '1');
  qs.append('filter', 'marketplace(US)');
  qs.append('filter', 'language(en)');
  qs.append('filter', `channelId(${CHANNEL_ID})`);
  qs.append('filter', `productInfo.merchProduct.styleColor(${code})`);

  let obj = null;
  try {
    const r = await fetchWithTimeout(`${FEED}?${qs}`, { headers: { accept: 'application/json' } }, 12000);
    if (r.ok) obj = (await r.json())?.objects?.[0] || null;
  } catch { obj = null; }

  // Bound the cache so a long-running server can't grow it without limit.
  if (threadCache.size > 200) threadCache.clear();
  threadCache.set(code, obj);
  return obj;
}

// Resolve a style code to Nike's own PDP imagery. Best-effort: every failure resolves
// to null so the caller degrades to the KicksDB sources, exactly like kicksdb.js.
// Returns the same shape kicksdbImagesBySku() does, plus per-image angle labels.
export async function nikeImagesBySku(sku) {
  const code = String(sku || '').trim().toUpperCase();
  if (!looksLikeNikeSku(code)) return null;

  const obj = await fetchThread(code);
  if (!obj) return null;

  const views = collectViews(obj);
  // A style code can resolve to a retired product that carries no imagery (e.g. the
  // Dunk "Panda" DD1391-100 returns a record with zero product views) — treat that
  // as a miss so the UI falls back to the other sources rather than showing nothing.
  const letters = Object.keys(views);
  if (!letters.length) return null;

  const ordered = [
    ...VIEW_ORDER.filter((v) => views[v]),
    ...letters.filter((v) => !VIEW_ORDER.includes(v)).sort(),
  ];
  const images = ordered.map((v) => imageUrl(views[v]));
  const labels = ordered.map((v) => VIEW_LABEL[v] || `View ${v}`);

  // One suggestion per slot, in the canonical order the slot strip uses.
  const suggestions = ordered
    .filter((v) => VIEW_ANGLE[v])
    .map((v) => ({ angle: VIEW_ANGLE[v], index: ordered.indexOf(v), label: VIEW_LABEL[v], url: imageUrl(views[v]) }));

  const merch = obj?.productInfo?.[0]?.merchProduct || {};
  return {
    source: 'nike', sourceLabel: 'Nike (official)',
    title: obj?.publishedContent?.properties?.title || null,
    sku: merch.styleColor || code,
    brand: merch.brand || 'Nike',
    hero: images[0],
    images,
    labels,
    suggestions,
  };
}

const stripHtml = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/\s+/g, ' ')
  .trim();

// Official product copy for the spec slide. Beats kicksdbSpecData() on the two things
// that actually print: the COLORWAY is Nike's own naming ("Obsidian/Doll/Persian
// Violet/White") rather than a marketplace's guess, and `subtitle` gives the real
// product category ("Men's Road Racing Shoes").
//
// Deliberately NOT used: `techSpec`, `bestFor`, `widths` and
// `manufacturingCountriesOfOrigin` came back empty on every product sampled, so
// nothing should be built on them.
export async function nikeSpecData(sku) {
  const code = String(sku || '').trim().toUpperCase();
  if (!looksLikeNikeSku(code)) return null;

  const obj = await fetchThread(code);
  const pc = obj?.productInfo?.[0]?.productContent;
  if (!pc) return null;

  return {
    name: pc.title || null,
    colorway: pc.colorDescription || '',
    description: stripHtml(pc.description),
    // Extras the marketplace catalogues don't carry.
    subtitle: pc.subtitle || '',
    heading: pc.descriptionHeading || '',
    // [{ type: 'PRIMARY', name: 'Obsidian', hex: '28303E' }, …]
    colors: Array.isArray(pc.colors) ? pc.colors : [],
  };
}
