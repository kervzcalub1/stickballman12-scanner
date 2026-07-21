// adidas image source for the PH "Image Finder".
//
// adidas has no usable first-party route: assets.adidas.com URLs embed a per-product
// hash that isn't derivable from the article code, adidas.com's HTML and APIs are
// Akamai-WAF'd from server IPs, and the CDN isn't search-indexed so the hash can't be
// discovered either. What DOES work is that a few retailers republish adidas' original
// studio files with adidas' own SEMANTIC FILENAMES intact:
//
//   Samba_OG_Shoes_White_IE3437_02_standard.jpg   → top-down
//   Samba_OG_Shoes_White_IE3437_03_standard.jpg   → outsole
//
// The angle comes from the FILENAME, not a position in the gallery. That distinction
// matters: the higher-resolution alternative (Sneakersnstuff, 2500px) can only be read
// positionally, and its ordering shifts per product — 8-image products put top at #7,
// 9-image products at #5 — so it silently mislabels. Verified here by eye on IE3437
// (Samba OG): _02 is the top-down, _03 is the outsole.
//
// Trade-off accepted: 840×840 max (Shopify won't upscale past the uploaded source;
// ?width=2048 and _2048x2048 both return 840). That lands ~1.17× when fitted into the
// 1050×770 template box — a mild, visually fine upscale.
//
// Unlike Nike's renditions these carry a baked drop shadow, so they still need the AI
// cutout — there's no pre-cut shortcut here.
import { fetchWithTimeout } from './util.js';

const CATALOG = 'https://asphalt-nyc.com/products.json';
const PAGES = 35;             // ~8.5k products; the tail is empty and simply yields nothing
const PAGE_SIZE = 250;
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;   // a throttled/partial crawl is retried on this shorter cycle
export const ADIDAS_IMG_HOST = 'cdn.shopify.com';

// adidas' two filename generations, both self-describing.
//   legacy:  <Product_Name>_<CODE>_<NN>_standard.jpg
//   current: <CODE>_<N>_FOOTWEAR_Photography_<View>_<colour>.jpg
const LEGACY_RE = /_([A-Z]{1,2}\d{4,6})_(\d{2})_(?:standard|detail)/;
const MODERN_RE = /([A-Z]{1,2}\d{4,6})_\d+_FOOTWEAR_Photography_([A-Za-z_]+?)_/;

// Legacy index → our angle slot. 41/42 are detail crops we don't place.
const LEGACY_ANGLE = { '01': 'side', '02': 'top', '03': 'outsole', '04': 'diagonal', '05': 'rear', '06': null };
const LEGACY_LABEL = { '01': 'Lateral', '02': 'Top-down', '03': 'Outsole', '04': '3/4 front', '05': '3/4 rear', '06': 'Medial', '41': 'Detail', '42': 'Detail' };
// Modern view word → our angle slot.
const MODERN_ANGLE = { Top_Portrait: 'top', Bottom: 'outsole', Side_Lateral_Center: 'side', Side_Medial_Center: null, Front_Center: 'diagonal', Back_Center: 'rear' };
const MODERN_LABEL = { Top_Portrait: 'Top-down', Bottom: 'Outsole', Side_Lateral_Center: 'Lateral', Side_Medial_Center: 'Medial', Front_Center: '3/4 front', Back_Center: 'Heel' };

// Placement order for the gallery strip (mirrors nike.js).
const SLOT_ORDER = ['side', 'diagonal', 'top', 'outsole', 'rear'];

const hostIs = (url, host) => {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.port === '' && u.hostname.toLowerCase() === host;
  } catch { return false; }
};
export const isAdidasImageUrl = (url) => hostIs(url, ADIDAS_IMG_HOST);

// adidas article codes: 2 letters + 4 digits (IE3437) or 1 letter + 5-6 digits (B75806).
const ADIDAS_CODE = /^[A-Z]{1,2}\d{4,6}$/i;
export const looksLikeAdidasSku = (sku) => ADIDAS_CODE.test(String(sku || '').trim());

// code -> { images: [{ url, angle, label }] }
let index = null;
let builtAt = 0;
let building = null;
// Live TTL: a clean crawl is good for a day, a throttled/partial one is retried soon.
let ttl = REFRESH_MS;
let lastStats = {};

function addImage(map, src) {
  const clean = String(src).split('?')[0];
  let code, angle, label;
  const legacy = LEGACY_RE.exec(clean);
  if (legacy) {
    code = legacy[1].toUpperCase();
    angle = LEGACY_ANGLE[legacy[2]] ?? null;
    label = LEGACY_LABEL[legacy[2]] || `View ${legacy[2]}`;
  } else {
    const modern = MODERN_RE.exec(clean);
    if (!modern) return;
    code = modern[1].toUpperCase();
    const view = modern[2].replace(/_View$/, '');
    angle = MODERN_ANGLE[view] ?? null;
    label = MODERN_LABEL[view] || view.replace(/_/g, ' ');
  }
  const entry = (map[code] ||= { images: [] });
  // First file wins per label — a product can repeat a view across colourway rows.
  if (entry.images.some((i) => i.label === label)) return;
  entry.images.push({ url: clean, angle, label });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch one catalogue page, retrying through Shopify's per-IP throttle. The store
// answers a burst with HTTP 429 `local_rate_limited`, which is transient — treating it
// as fatal would silently leave a partial index that looks complete.
async function fetchPage(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetchWithTimeout(`${CATALOG}?limit=${PAGE_SIZE}&page=${page}`, { headers: { accept: 'application/json' } }, 20000);
      if (r.ok) return (await r.json())?.products || [];
      if (r.status !== 429 && r.status < 500) return null;   // real error — don't hammer it
    } catch { /* network blip — retry */ }
    await sleep(1000 * 2 ** attempt);                        // 1s, 2s, 4s
  }
  return null;
}

async function buildIndex() {
  const map = {};
  let consecutiveFailures = 0;
  let ok = 0, failed = 0, reachedEnd = false;
  // Sequential + paced. Fetching all 35 pages at once is what triggers the throttle in
  // the first place, and this runs in the background where latency doesn't matter.
  for (let page = 1; page <= PAGES; page++) {
    const products = await fetchPage(page);
    if (products === null) {
      failed++;
      // Give up only if the store is persistently unhappy; a single bad page shouldn't
      // discard the other 34.
      if (++consecutiveFailures >= 3) break;
      continue;
    }
    consecutiveFailures = 0;
    ok++;
    if (!products.length) { reachedEnd = true; break; }      // past the end of the catalogue
    for (const p of products) for (const im of p.images || []) addImage(map, im.src);
    await sleep(300);
  }
  // A crawl cut short by throttling yields an index that LOOKS fine but is missing
  // codes — a lookup then reports "no match" for a shoe we can actually serve. Report
  // completeness so the caller can refuse to cache a truncated crawl for a full day.
  return { map, ok, failed, complete: reachedEnd && failed === 0 };
}

// Kick off a build if the index is missing or stale. Never awaited by a request —
// the first lookup for a cold index returns null and the NEXT one is served. A 35-page
// crawl inside an HTTP handler would blow the request budget.
function ensureIndex() {
  const stale = !index || Date.now() - builtAt > ttl;
  if (stale && !building) {
    building = buildIndex()
      .then(({ map, ok, failed, complete }) => {
        const codes = Object.keys(map).length;
        if (!codes) return;                       // total failure — keep whatever we had
        // Only trust a truncated crawl if we have nothing better, and retry it soon
        // instead of serving the gaps for a full day.
        if (!complete && index && codes < Object.keys(index).length) {
          ttl = RETRY_MS;
          console.warn(`[adidas] partial crawl (${ok} ok / ${failed} failed, ${codes} codes) — keeping previous index`);
          return;
        }
        index = map; builtAt = Date.now(); lastStats = { ok, failed, complete, codes };
        ttl = complete ? REFRESH_MS : RETRY_MS;
        if (!complete) console.warn(`[adidas] partial crawl cached (${ok} ok / ${failed} failed, ${codes} codes) — retrying in ${RETRY_MS / 60000}m`);
      })
      .catch(() => {})
      .finally(() => { building = null; });
  }
  return index;
}

// Exposed so a caller can warm the cache at startup rather than paying a cold miss.
export function warmAdidasIndex() { ensureIndex(); return building; }
export function adidasIndexReady() { return Boolean(index); }
// Crawl health, for debugging a "why is this code missing?" report.
export function adidasIndexStats() { return { ...lastStats, builtAt, ttlMs: ttl }; }

// Resolve an adidas article code to its studio set. Same shape as nikeImagesBySku.
// Returns null on a cold index, an unknown code, or a non-adidas-looking SKU.
export async function adidasImagesBySku(sku) {
  const code = String(sku || '').trim().toUpperCase();
  if (!looksLikeAdidasSku(code)) return null;

  const map = ensureIndex();
  const entry = map?.[code];
  if (!entry?.images?.length) return null;

  // Placeable angles first (in slot order), then the rest.
  const ranked = [...entry.images].sort((a, b) => {
    const ai = a.angle ? SLOT_ORDER.indexOf(a.angle) : 99;
    const bi = b.angle ? SLOT_ORDER.indexOf(b.angle) : 99;
    return ai - bi;
  });

  const seen = new Set();
  const suggestions = [];
  ranked.forEach((img, i) => {
    if (img.angle && !seen.has(img.angle)) {
      seen.add(img.angle);
      suggestions.push({ angle: img.angle, index: i, label: img.label, url: img.url });
    }
  });

  return {
    source: 'adidas', sourceLabel: 'adidas (studio)',
    title: null, sku: code, brand: 'adidas',
    hero: ranked[0].url,
    images: ranked.map((i) => i.url),
    labels: ranked.map((i) => i.label),
    suggestions,
  };
}
