// KicksDB (api.kicks.dev) client — used by the PH "Image Finder" to source clean
// StockX product renders (hero + 36-frame 360° spin) for a SKU. Key is server-side
// only (KICKSDB_KEY). Best-effort: every failure resolves to null so the caller
// degrades gracefully.
//
// The 360° spin is a fixed horizontal rotation that ALWAYS starts at the lateral
// side and turns a consistent direction (36 frames = 10° each), so a frame INDEX
// maps to the same physical angle across silhouettes. That's what lets us suggest
// the 5 listing angles below by index. (Top-down + outsole are NOT in a horizontal
// spin — those stay manual on the Edited-Photos page.)
import { fetchWithTimeout, cacheGet, cacheSet } from './util.js';

const GOAT_BASE = 'https://api.kicks.dev/v3/goat/products';
const STOCKX_BASE = 'https://api.kicks.dev/v3/stockx/products';
export const STOCKX_IMG_HOST = 'images.stockx.com';
export const GOAT_IMG_HOST = 'image.goat.com';

// GOAT's curated gallery (`images[]`) is ordered but its length varies per shoe, so
// only the front of the run is index-stable. Verified across silhouettes: 0 = lateral
// (outer), 3 = outsole (sole). We auto-suggest just those two rock-solid slots and let
// PH tap the rest (3/4, top, heel) from the gallery. Standard product_photos angles.
export const GOAT_SUGGESTIONS = [
  { angle: 'side', index: 0, label: 'Lateral' },
  { angle: 'outsole', index: 3, label: 'Sole' },
];
// StockX 360° spin fallback (36 frames = 10°, starts lateral): only side/diagonal/rear
// are placeable — a horizontal spin has no top or sole.
export const STOCKX_360_SUGGESTIONS = [
  { angle: 'side', index: 0, label: 'Lateral' },
  { angle: 'diagonal', index: 3, label: '3/4' },
  { angle: 'rear', index: 27, label: 'Heel' },
];

// Keys in priority order: the primary, then any backups. A KicksDB key that has hit its
// plan limit is DEACTIVATED, and a deactivated key answers `401 {"detail":"Key is not
// active"}` — indistinguishable from a typo'd key. So 401 has to be treated as "this key
// is spent, try the next one" rather than a hard error, which is the whole reason this
// list exists. Read from env every call so a Railway var change takes effect on the next
// request, with no redeploy.
export function kicksdbKeys() {
  return [...new Set([process.env.KICKSDB_KEY, process.env.KICKSDB_KEY_2].filter(Boolean))];
}

export function kicksdbConfigured() {
  return kicksdbKeys().length > 0;
}

// Statuses that mean "the KEY is the problem", not the request: deactivated/limit-hit
// (401), payment required (402), forbidden (403), rate-limited (429). Anything else is a
// real failure and failing over would just burn the backup key for nothing.
const KEY_FAILURE_STATUS = new Set([401, 402, 403, 429]);
// How long a spent key is skipped before we probe it again. Long enough that a dead key
// isn't re-tried on every request, short enough that topping the plan back up recovers on
// its own without a redeploy.
const KEY_COOLDOWN_MS = 30 * 60 * 1000;
const spentKeys = new Map(); // key -> timestamp it may be retried

const keyLabel = (k) => `#${kicksdbKeys().indexOf(k) + 1}`;  // never log the key itself

// The keys worth spending a call on, best first. When every key is in cooldown we return
// exactly ONE — the closest to recovery — so an all-dead state costs a single probe per
// request instead of one per key.
function keysToTry() {
  const all = kicksdbKeys();
  const now = Date.now();
  const live = all.filter((k) => !(spentKeys.get(k) > now));
  if (live.length) return live;
  return all.length ? [all.reduce((a, b) => ((spentKeys.get(a) ?? 0) <= (spentKeys.get(b) ?? 0) ? a : b))] : [];
}

// Exported for diagnostics/tests: which keys are configured and which are in cooldown.
export function kicksdbKeyHealth() {
  const now = Date.now();
  return kicksdbKeys().map((k, i) => ({
    key: `#${i + 1}`,
    spent: spentKeys.get(k) > now,
    retryInMs: spentKeys.get(k) > now ? spentKeys.get(k) - now : 0,
  }));
}

const hostIs = (url, host) => {
  try {
    const u = new URL(String(url));
    // Pin protocol, host AND default port (443) — same rigor as r2.isAllowedPhotoUrl, so a
    // different service on a non-443 port of the same host can't be reached.
    return u.protocol === 'https:' && u.port === '' && u.hostname.toLowerCase() === host;
  } catch { return false; }
};
export const isStockxImageUrl = (url) => hostIs(url, STOCKX_IMG_HOST);
export const isGoatImageUrl = (url) => hostIs(url, GOAT_IMG_HOST);
// The SSRF allowlist for the import endpoint (fetches these bytes server-side):
// only the StockX or GOAT image CDNs. Mirrors r2.isAllowedPhotoUrl.
export const isAllowedSourceImageUrl = (url) => isStockxImageUrl(url) || isGoatImageUrl(url);

const normSku = (s) => (s ? String(s).trim().replace(/\s+/g, '-') : null);

// Upgrade a GOAT additional-picture URL to the full-resolution rendition. The
// gallery serves `/medium/` (~24 KB, soft when upscaled to 1600²); `/original/`
// (~120 KB) is the sharp source we want for branding. No-op for other hosts.
export function hiResSourceUrl(url) {
  const s = String(url || '');
  if (isGoatImageUrl(s) && s.includes('/medium/')) return s.replace('/medium/', '/original/');
  return s;
}
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// KicksDB is the only METERED image/spec source (Nike + adidas are keyless), so every
// call is cached per catalog+SKU. Caching here rather than in the two exported functions
// means the GOAT hit that images/search made is reused by the spec slide and the eBay
// listing for the same shoe — one PH session on a SKU used to cost up to 4 calls. Product
// copy is effectively immutable, so a long TTL is safe; misses are cached too (wrapped, so
// `null` is representable) to stop a SKU KicksDB doesn't carry from being re-asked all day.
const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

// GET one KicksDB catalog and return its first product, or null. Best-effort: walks the
// key list, failing over to the backup when a key comes back spent (see KEY_FAILURE_STATUS).
async function fetchProduct(base, query, extraQs = '') {
  if (!query) return null;
  const url = `${base}?query=${encodeURIComponent(String(query))}${extraQs}&limit=1`;
  const ck = `kicksdb:${url}`;
  const hit = cacheGet(ck);
  if (hit) return hit.product;

  for (const key of keysToTry()) {
    let r;
    try {
      r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${key}`, accept: 'application/json' } }, 12000);
    } catch { return null; }  // network/timeout — not the key's fault, don't burn the backup

    if (KEY_FAILURE_STATUS.has(r.status)) {
      spentKeys.set(key, Date.now() + KEY_COOLDOWN_MS);
      // Loud on purpose: a silent failover means nobody notices the plan ran out until the
      // LAST key dies and imagery quietly disappears.
      console.warn(`[kicksdb] key ${keyLabel(key)} rejected (HTTP ${r.status}) — trying the next key. Top up or rotate KICKSDB_KEY.`);
      continue;
    }
    // Only cache a real answer (200 or an honest empty result). A timeout/5xx is a transient
    // failure, not a fact about the SKU — caching it would blank the shoe for the next 12 h.
    if (!r.ok) return null;
    let product = null;
    try { product = (await r.json())?.data?.[0] || null; } catch { return null; }
    spentKeys.delete(key);  // it answered — clear any stale cooldown
    cacheSet(ck, { product }, CATALOG_TTL_MS);
    return product;
  }
  return null;  // no key left with credit
}

const buildSuggestions = (defs, images) =>
  defs.map((s) => ({ ...s, url: images[s.index] || null })).filter((s) => s.url);

// Colorway + marketplace description for a SKU (for the branded spec slide). GOAT
// first (richer description + colorway), StockX as backup. Best-effort → {} on miss.
export async function kicksdbSpecData(query) {
  const goat = await fetchProduct(GOAT_BASE, query);
  const sx = (!goat?.description || !goat?.colorway) ? await fetchProduct(STOCKX_BASE, query, '&display[variants]=true') : null;
  return {
    name: goat?.name || goat?.nickname || sx?.title || null,
    colorway: goat?.colorway || sx?.colorway || '',
    description: goat?.description || sx?.description || '',
  };
}

// Resolve the best available images for a SKU, cascading GOAT curated gallery →
// StockX 360° spin → hero image(s). Returns null only when nothing at all is found.
// { source, sourceLabel, title, sku, brand, hero, images[], suggestions[] }.
export async function kicksdbImagesBySku(query) {
  if (!kicksdbConfigured() || !query) return null;
  const goat = await fetchProduct(GOAT_BASE, query);

  // 1) GOAT curated gallery — real retail angles incl. outsole (& top when present).
  const goatImages = Array.isArray(goat?.images) ? goat.images.filter(isGoatImageUrl) : [];
  const goatHero = isGoatImageUrl(goat?.image_url) ? goat.image_url : null;
  if (goatImages.length) {
    return {
      source: 'goat', sourceLabel: 'GOAT gallery',
      title: goat.name || goat.nickname || null, sku: normSku(goat.sku), brand: goat.brand || null,
      hero: goatHero || goatImages[0], images: goatImages,
      suggestions: buildSuggestions(GOAT_SUGGESTIONS, goatImages),
    };
  }

  // Otherwise pull StockX for the fallbacks.
  const sx = await fetchProduct(STOCKX_BASE, query, '&display[variants]=true');
  const frames = Array.isArray(sx?.gallery_360) ? sx.gallery_360.filter(isStockxImageUrl) : [];
  const sxGallery = Array.isArray(sx?.gallery) ? sx.gallery.filter(isStockxImageUrl) : [];
  const sxHero = isStockxImageUrl(sx?.image) ? sx.image : null;
  const title = goat?.name || goat?.nickname || sx?.title || sx?.primary_title || null;
  const sku = normSku(goat?.sku || sx?.sku);
  const brand = goat?.brand || sx?.brand || null;

  // 2) StockX 360° spin — rotational angles when GOAT has no curated gallery.
  if (frames.length) {
    return {
      source: 'stockx_360', sourceLabel: 'StockX 360° spin',
      title, sku, brand, hero: sxHero || frames[0], images: frames,
      suggestions: buildSuggestions(STOCKX_360_SUGGESTIONS, frames),
    };
  }

  // 3) Hero image(s) only — at least the main product shot from either catalog.
  const heroes = uniq([goatHero, sxHero, ...sxGallery]).filter(isAllowedSourceImageUrl);
  if (heroes.length) {
    return {
      source: 'hero', sourceLabel: 'hero image only',
      title, sku, brand, hero: heroes[0], images: heroes,
      suggestions: heroes[0] ? [{ angle: 'side', index: 0, label: 'Lateral', url: heroes[0] }] : [],
    };
  }

  return null;
}
