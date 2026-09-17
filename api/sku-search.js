// POST /api/sku-search  { sku }  ->  { ok, product }
// What shoe — or garment — is this style code? This is the ONE lookup behind every
// screen that resolves a code to a name: Receiving, the PO scan modal, Box Labels,
// Existing Stock, Buy Cart, the Payout Calculator, Price Inquiry, Inventory and the
// rescale-request form. Whatever it can't answer, none of them can.
//
// **Three sources, in order: Alias → StockX → Nike** (2026-09-18). Alias remains first
// and is still the only one that returns a catalog_id (which the pricing paths need)
// and a size run, so nothing about an ordinary sneaker changes.
//
// The other two exist because Alias and KicksDB are SNEAKER catalogues, and a code for
// anything else dead-ended at "No product found" on all nine screens at once. A Nike x
// Stüssy hoodie (FJ9175-261) and a PSG match jersey (HJ4547-411) both came back empty
// while Nike's own catalogue had each of them — so a manifest carrying one had to have
// its title typed by hand, from memory, with nothing to check it against.
//
// `product.source` says which one answered, and it is already carried through Receiving
// onto `items.source`, so the record keeps saying where the name came from.
import {
  getJsonBody, send, applySecurity, rateLimit, requireRole, cleanSku,
  cacheGet, cacheSet, normalizeGender, skuCodes,
} from './_lib/util.js';
import { aliasCatalogBySku } from './_lib/alias.js';
import { stockxConfigured, stockxProductBySku } from './_lib/stockx.js';
import { looksLikeNikeSku, nikeImagesBySku } from './_lib/nike.js';

// Sort sizes numerically (1, 1.5, 2 … 13) — Alias usually returns them in order,
// but normalize defensively so the UI's size table is always ascending.
function sortSizes(list) {
  const num = (s) => { const m = String(s).match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN; };
  return [...list].sort((a, b) => {
    const na = num(a); const nb = num(b);
    if (Number.isNaN(na) && Number.isNaN(nb)) return String(a).localeCompare(String(b));
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return na - nb;
  });
}

// Map the Alias catalog hit to our shared product shape. Alias writes the SKU
// with a space ("DQ8426 109"); normalize to the dash form the app uses. No UPC
// here (the catalog is per-SKU; UPCs are per-size) — same as the old behavior.
function normalize(c, querySku) {
  if (!c) return null;
  // A dual code the user typed ("315122-111/CW2288-111") has to survive the round
  // trip: Alias searched on the first code and answers with that one alone, so
  // trusting its reply here would quietly halve what was asked for.
  const typed = skuCodes(querySku);
  const sku = typed.length > 1
    ? typed.join('/')
    : ((c.sku || querySku || '').replace(/\s+/g, '-') || null);
  return {
    name: c.name || 'Unknown product',
    sku,
    skuOptions: typed.length > 1 ? typed : [],
    upc: null,
    image: c.image || null,
    brand: c.brand || null,
    colorway: c.colorway || null,
    sizes: sortSizes(c.sizes || []),
    gender: normalizeGender(c.gender, { size: c.sizes?.[0] || '', title: c.name || '' }),
    source: 'alias',
  };
}

// The SKU to report back, given what the user typed. Identical rule to normalize()
// above: a dual code they typed survives the round trip, because the upstream searched
// on the first code alone and answering with just that one would quietly halve the ask.
function echoSku(upstreamSku, querySku) {
  const typed = skuCodes(querySku);
  if (typed.length > 1) return { sku: typed.join('/'), skuOptions: typed };
  return { sku: (upstreamSku || querySku || '').replace(/\s+/g, '-') || null, skuOptions: [] };
}

// StockX, second. It carries apparel that Alias doesn't, and its titles are the fullest
// we get ("… Authentic Jersey Midnight Navy/Midnight Navy/White").
//
// **EXACT STYLE-ID MATCHES ONLY.** `stockxProductBySku` falls back to the closest search
// result when nothing matches exactly and flags it `exact: false` — deliberate there,
// because a near hit is usually the right shoe in another colourway and the screen can
// say so. It is NOT safe here. Asked for FJ9175-261 (a Stüssy hoodie) it answers with
// FJ4195-201, "Nike Waffle Nav" — a different product entirely. Auto-filling that onto a
// receiving line or a PO manifest files a garment as a shoe under a name nobody typed,
// which is worse than the blank field this endpoint used to return.
//
// No sizes: StockX keeps them on variants, a second call per lookup, and this endpoint
// is on the scan path. No catalogId either — that is Alias's, and the pricing paths must
// keep failing honestly rather than pricing against a shoe we didn't match.
export function fromStockx(p, querySku) {
  if (!p || !p.exact) return null;
  const { sku, skuOptions } = echoSku(p.styleId, querySku);
  return {
    name: p.title || 'Unknown product',
    sku,
    skuOptions,
    upc: null,
    image: null,
    brand: 'Nike',
    colorway: p.colorway || null,
    sizes: [],
    gender: null,
    source: 'stockx',
  };
}

// Nike, last. Queried directly on the style code (`styleColor(...)`), so a hit is Nike's
// own catalogue confirming the code exists — it never echoes an unmatched input back.
// Name and images only: no sizes, no colourway, no catalog_id.
//
// `looksLikeNikeSku` gates it, so an adidas or New Balance code costs nothing here.
export function fromNike(p, querySku) {
  if (!p || !p.title) return null;
  const { sku, skuOptions } = echoSku(p.sku, querySku);
  return {
    name: p.title,
    sku,
    skuOptions,
    upc: null,
    image: p.hero || null,
    brand: p.brand || 'Nike',
    colorway: null,
    sizes: [],
    gender: null,
    source: 'nike',
  };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team', 'supplier'])) return; // PH: rescale-request form · supplier: PO scan-out product lookup
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  if (!process.env.ALIAS_API_KEY) return send(res, 500, { ok: false, error: 'Server is missing the Alias API key.' });

  const body = await getJsonBody(req);
  const sku = cleanSku(body.sku);
  if (!sku) return send(res, 400, { ok: false, error: 'Invalid SKU.' });

  // Repeat lookups of the same SKU skip the upstream round trip.
  const cacheKey = `sku:${sku.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return send(res, 200, { ok: true, product: cached, cached: true });

  // Alias first — the only source with a catalog_id and a size run, so an ordinary
  // sneaker never reaches the fallbacks and nothing about it changes. Its failure is
  // HELD rather than thrown: a timeout means we don't know, not that the code is
  // unknown, and a code Nike can confirm shouldn't go unanswered because Alias is
  // having a slow minute. It is re-raised below only if nothing else answers either.
  let aliasErr = null;
  let product = null;
  try {
    product = normalize(await aliasCatalogBySku(sku), sku);
  } catch (e) { aliasErr = e; }

  // StockX, then Nike. Each is best-effort and independently guarded: a fallback that
  // throws must not turn a lookup Alias already answered — or the next source could —
  // into an error. Both are skipped entirely once something has answered, so the scan
  // path pays for at most the sources it needs.
  if (!product && stockxConfigured()) {
    try { product = fromStockx(await stockxProductBySku(sku), sku); } catch { /* next source */ }
  }
  if (!product && looksLikeNikeSku(sku)) {
    try { product = fromNike(await nikeImagesBySku(sku), sku); } catch { /* out of sources */ }
  }
  // StockX has the fullest TITLE and no image; Nike has the image. Borrow it, so an
  // apparel line in Receiving or on a label shows a picture instead of a grey box —
  // a photo is how somebody checks the name against the thing in their hands.
  // Only ever on a StockX hit (an Alias hit already carries its own image), so this
  // costs one extra call on apparel lookups alone and never on the sneaker path.
  if (product && product.source === 'stockx' && !product.image && looksLikeNikeSku(sku)) {
    try {
      const n = await nikeImagesBySku(sku);
      if (n?.hero) product = { ...product, image: n.hero };
    } catch { /* the name is the answer; the picture is a bonus */ }
  }

  if (product) {
    cacheSet(cacheKey, product);
    return send(res, 200, { ok: true, product });
  }

  // Nothing found. If Alias was the one that broke, say THAT rather than "no such SKU":
  // a timeout is not an answer, and reporting it as one sends somebody hunting for a
  // catalogue problem that doesn't exist. The raw abort text ("This operation was
  // aborted") is worse still — it names nothing the person can act on.
  if (aliasErr) {
    if (aliasErr.name === 'AbortError' || aliasErr.name === 'TimeoutError') {
      return send(res, 504, { ok: false, timeout: true,
        error: 'The product catalogue didn’t answer in time. Try that scan again.' });
    }
    return send(res, 502, { ok: false, error: aliasErr.message || 'Upstream error.' });
  }
  return send(res, 404, { ok: false, error: 'No product found for that SKU.' });
}
