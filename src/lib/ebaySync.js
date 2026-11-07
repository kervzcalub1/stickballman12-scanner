// eBay Sync, the pure half (docs/ebay-sync-plan.md, docs/context/ebay-sync.md): stock, price, content,
// new listings, ending. NOT orders: DPL keeps those. No IO here:
// the engine (api/_lib/ebay-sync.js) reads eBay and Shopify, asks THESE functions what to do,
// and only then writes. Everything is testable with plain objects.
import { styleFromTitle } from './ebayReprice.js';

export const SWITCHES = ['stock', 'price', 'content', 'create', 'end'];
export const MODES = ['off', 'shadow', 'live'];
export const DEFAULT_SETTINGS = {
  switches: { stock: 'shadow', price: 'shadow', content: 'shadow', create: 'shadow', end: 'shadow' },
  kill: false, blastPct: 10,
};
export const TITLE_MAX = 80;
export const MAX_VARIATIONS = 250;
export const MAX_PICTURES = 12;

// Settings from whatever is stored: unknown switch values fall back to shadow (never to live).
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const switches = {};
  for (const k of SWITCHES) switches[k] = MODES.includes(r.switches?.[k]) ? r.switches[k] : 'shadow';
  const blast = Number(r.blastPct);
  return {
    switches, kill: r.kill === true,
    blastPct: Number.isFinite(blast) && blast > 0 && blast <= 100 ? blast : DEFAULT_SETTINGS.blastPct,
  };
}
// The one gate in front of every eBay / Shopify write this feature makes.
// Writes also need the SERVER to be allowed to write: production, or EBAY_SYNC_WRITES=on. A copy of the app
// on a laptop shares the real eBay account and must never write to it, whatever the switches say.
export const writesAllowed = (env = typeof process !== 'undefined' ? process.env : {}) =>
  String(env.EBAY_SYNC_WRITES || '').trim().toLowerCase() === 'on' || String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
export const canWrite = (settings, domain) => settings?.switches?.[domain] === 'live' && settings?.kill !== true && writesAllowed();
export const modeOf = (settings, domain) => (canWrite(settings, domain) ? 'live' : 'shadow');

// A listing profile that would make eBay refuse every new listing, or price them wrongly, is refused up front.
export function validateProfile(c) {
  const bad = (m) => m;
  if (!c || typeof c !== 'object') return bad('The profile needs its settings.');
  const u = Number(c.uplift ?? 0);
  if (!Number.isFinite(u) || u < 0 || u > 100) return bad('The price uplift must be a number from 0 to 100 percent.');
  for (const k of ['categoryId', 'postalCode', 'location', 'collection']) if (!trim(c[k])) return bad(`The profile needs ${k}.`);
  for (const k of ['shipping', 'return', 'payment']) if (!/^\d{6,}$/.test(trim(c.policies?.[k]))) return bad(`The ${k} policy id must be the number from eBay's business policies.`);
  if (!(Number(c.conditionId) > 0)) return bad('The profile needs a condition id.');
  return null;
}

/* ------------------------------ small helpers ------------------------------ */

const trim = (v) => String(v ?? '').trim();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const centsToMoney = (c) => (Math.round(Number(c) || 0) / 100).toFixed(2);
export const textOf = (html) => String(html ?? '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/\s+/g, ' ').trim().toLowerCase();
const sizeNum = (s) => { const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : Infinity; };
const capFirst = (s) => (s && s === s.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// A stable short hash of any JSON-able value (change detection, not security).
export function hashOf(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* ---------------------------------- links ---------------------------------- */

// eBay rows (one per size, as rowsFromItem returns them) + Shopify variants -> link rows, by EXACT
// SKU. A SKU used twice on either side is flagged and linked to nothing: never guessed.
export function buildLinks({ ebayRows = [], variants = [] }) {
  const shopBySku = new Map();
  for (const v of variants) { const s = trim(v.sku); if (s) shopBySku.set(s, [...(shopBySku.get(s) || []), v]); }
  const ebayBySku = new Map();
  for (const r of ebayRows) { const s = trim(r.sku); if (s) ebayBySku.set(s, [...(ebayBySku.get(s) || []), r]); }
  const dupShopify = new Set([...shopBySku].filter(([, l]) => l.length > 1).map(([s]) => s));
  const dupEbay = new Set([...ebayBySku].filter(([, l]) => l.length > 1).map(([s]) => s));
  const links = [];
  const keys = new Set();
  const uniq = (k) => { let key = k; for (let i = 2; keys.has(key); i++) key = `${k}#${i}`; keys.add(key); return key; };
  for (const r of ebayRows) {
    const sku = trim(r.sku);
    const v = sku && !dupShopify.has(sku) ? shopBySku.get(sku)?.[0] : null;
    const duplicate = !!sku && (dupShopify.has(sku) || dupEbay.has(sku));
    links.push({
      link_key: uniq(`${r.item_id}|${r.variation_key || sku}`), sku: sku || null, item_id: String(r.item_id), variation_key: r.variation_key || '',
      shopify_product_id: duplicate ? null : (v?.productId ?? null), shopify_variant_id: v?.variantId ?? null,
      title: r.title || null, size: r.size ?? v?.size ?? null, view_url: r.view_url || null,
      ebay_qty: r.qty_available == null ? null : Number(r.qty_available), shopify_qty: v ? v.qty : null,
      ebay_price: r.price == null ? null : Number(r.price), shopify_price: v?.price == null ? null : Number(v.price),
      duplicate, base: duplicate ? 'duplicate' : (v ? 'linked' : 'no_shopify'),
    });
  }
  for (const [sku, list] of shopBySku) {
    const v = list[0];
    if (list.length > 1 || ebayBySku.has(sku) || v.status !== 'ACTIVE' || !(Number(v.qty) > 0)) continue;
    links.push({
      link_key: uniq(`|${sku}`), sku, item_id: '', variation_key: '', shopify_product_id: v.productId, shopify_variant_id: v.variantId,
      title: v.productTitle || null, size: v.size || null, view_url: null, ebay_qty: null, shopify_qty: v.qty,
      ebay_price: null, shopify_price: v.price == null ? null : Number(v.price), duplicate: false, base: 'not_on_ebay',
    });
  }
  return { links, dupShopify, dupEbay, noSku: variants.filter((v) => !trim(v.sku)).length };
}

/* ---------------------------- stock + price decisions ---------------------------- */

// eBay quantity = max(0, Shopify available), only from a complete Shopify read. A size on eBay with
// no Shopify variant is reported, never zeroed by itself.
export function stockDecision({ hasVariant, shopifyQty, ebayQty, shopifyComplete }) {
  if (!hasVariant) return { action: 'report', reason: 'No Shopify variant carries this SKU.' };
  if (!shopifyComplete || shopifyQty == null || !Number.isFinite(Number(shopifyQty))) return { action: 'none', reason: 'Shopify stock could not be read completely.' };
  const target = Math.max(0, Math.round(Number(shopifyQty)));
  return ebayQty === target ? { action: 'none', target } : { action: 'set', target };
}

// Which rule a size's price is under.
//   kept_lock / kept_repriced  a lock, or a size our reprice tool already sent
//   follows_shopify            eBay really was tracking Shopify on the previous pass (equal, or still catching up)
//   kept_manual                eBay's price differs and it was NOT tracking Shopify (set in a CSV, Seller Hub, an unlogged reprice)
// With no previous pass: equal means it follows; otherwise it is kept as set on eBay. Never overwrite a price we never owned.
export function priceRule({ locked = false, edited = false, prev = null, ebayPrice, shopifyPrice, uplift = 0 }) {
  if (locked) return 'kept_lock';
  if (edited) return 'kept_repriced';
  const tgt = (sp) => { const n = Number(sp); return Number.isFinite(n) && n > 0 ? round2(n * (1 + (Number(uplift) || 0) / 100)) : null; };
  const equal = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;
  const now = tgt(shopifyPrice);
  if (equal(ebayPrice, now)) return 'follows_shopify';
  if (!prev) return 'kept_manual';
  const wasFollowing = prev.price_rule === 'follows_shopify' || equal(prev.ebay_price, tgt(prev.shopify_price));
  if (!wasFollowing) return 'kept_manual';
  // It was following, and now differs: either Shopify moved (follow) or someone changed eBay under us (keep).
  const shopifyMoved = !equal(prev.shopify_price, shopifyPrice);
  const ebayMoved = !equal(prev.ebay_price, ebayPrice);
  return ebayMoved && !shopifyMoved ? 'kept_manual' : 'follows_shopify';
}
export function priceDecision({ ebayPrice, shopifyPrice, locked = false, edited = false, uplift = 0, prev = null }) {
  const sp = Number(shopifyPrice);
  const target = Number.isFinite(sp) && sp > 0 ? round2(sp * (1 + (Number(uplift) || 0) / 100)) : null;
  const rule = priceRule({ locked, edited, prev, ebayPrice, shopifyPrice, uplift });
  if (rule !== 'follows_shopify') return { rule, target, action: 'none' };
  if (target == null) return { rule, target, action: 'none', reason: 'No usable Shopify price.' };
  if (ebayPrice != null && Math.abs(Number(ebayPrice) - target) < 0.005) return { rule, target, action: 'none' };
  return { rule, target, action: 'set' };
}

// A link's full verdict: the state shown on the Linked Inventory tab, plus what to send. `prev` = this link's row from the last pass.
export function decideLink(link, { shopifyComplete = true, lockedItems = new Set(), editedKeys = new Set(), uplift = 0, prev = null } = {}) {
  if (link.base === 'duplicate') return { ...link, state: 'duplicate', price_rule: null, stock: { action: 'none' }, price: { action: 'none' } };
  if (link.base === 'not_on_ebay') return { ...link, state: 'not_on_ebay', price_rule: null, stock: { action: 'none' }, price: { action: 'none' } };
  if (link.base === 'no_shopify') return { ...link, state: 'no_shopify', price_rule: null, stock: stockDecision({ hasVariant: false }), price: { action: 'none' } };
  const stock = stockDecision({ hasVariant: true, shopifyQty: link.shopify_qty, ebayQty: link.ebay_qty, shopifyComplete });
  const price = priceDecision({
    ebayPrice: link.ebay_price, shopifyPrice: link.shopify_price, uplift, prev,
    locked: lockedItems.has(String(link.item_id)), edited: editedKeys.has(`${link.item_id}|${link.variation_key}`),
  });
  const keptDiffers = price.rule !== 'follows_shopify' && price.target != null && link.ebay_price != null && Math.abs(link.ebay_price - price.target) >= 0.005;
  const state = stock.action === 'set' ? 'qty_drift' : price.action === 'set' ? 'price_drift' : keptDiffers ? 'price_kept' : 'ok';
  return { ...link, state, price_rule: price.rule, stock, price };
}

// DPL normally fixes a difference within minutes, so a difference only counts once it has been seen
// on an earlier pass too. `since` = when it was first seen (null = not drifting). Returns the new since.
export function driftSince(prevSince, drifting, now = new Date()) {
  if (!drifting) return null;
  return prevSince ? new Date(prevSince) : new Date(now);
}
export const driftPersists = (since, now = new Date(), minMin = 10) => !!since && (new Date(now).getTime() - new Date(since).getTime()) >= minMin * 60_000;

/* ---------------------------- blast + read guards ---------------------------- */

// Stop a pass that would change too much at once, or whose Shopify read shrank. A bad read must
// never look like "everything is out of stock".
export function blastCheck({ changes, total, blastPct = 10 }) {
  const t = Math.max(1, Number(total) || 0);
  const pct = (Number(changes) / t) * 100;
  return { stop: Number(changes) > 0 && pct > blastPct, pct: Math.round(pct * 10) / 10, changes: Number(changes) || 0, total: t, blastPct };
}
export function readGuard({ shopify, lastShopifyCount = 0, ebayRows, lastEbayRows = 0, products = null, lastProductCount = 0, acceptCounts = false }) {
  if (!shopify || shopify.error) return { ok: false, why: `Shopify could not be read${shopify?.error ? `: ${shopify.error}` : ''}.` };
  if (shopify.truncated) return { ok: false, why: 'The Shopify read was cut short (too many pages), so it is not complete.' };
  const n = (shopify.variants || []).length;
  if (acceptCounts) return { ok: true };
  if (products && lastProductCount > 0 && products.length < lastProductCount * 0.9) return { ok: false, why: `The Shopify product list shrank from ${lastProductCount} to ${products.length} (over 10%).`, shrank: true };
  if (lastShopifyCount > 0 && n < lastShopifyCount * 0.9) return { ok: false, why: `The Shopify read shrank from ${lastShopifyCount} to ${n} variants (over 10%).`, shrank: true };
  if (lastEbayRows > 0 && (ebayRows || []).length < lastEbayRows * 0.9) return { ok: false, why: `The eBay read shrank from ${lastEbayRows} to ${(ebayRows || []).length} sizes (over 10%).`, shrank: true };
  return { ok: true };
}

/* ------------------------------- the listing ------------------------------- */

// Most Shopify barcodes here are just the 8-digit SKU, and eBay refuses those on a new listing
// (21919326, seen on VerifyAddFixedPriceItem 2026-11-08). Only a real UPC/EAN goes through.
const realUpc = (b) => (/^\d{12,14}$/.test(trim(b)) ? trim(b) : 'Does not apply');

// Shopify product (full read) + profile -> the data for Trading XML, as DPL's listings read in
// Phase 0: title and description verbatim, Brand = vendor, Style Code from the title, one variation
// specific "Size", SKU, UPC = barcode, only sizes with stock, up to 12 pictures.
export function buildListing(product, profile) {
  const p = profile || {};
  const title = trim(product.title);
  const style = styleFromTitle(title);
  const brand = capFirst(trim(product.vendor));
  const uplift = Number(p.uplift) || 0;
  const variations = (product.variants || [])
    .filter((v) => Number(v.qty) > 0 && trim(v.sku))
    .map((v) => ({
      sku: trim(v.sku), size: trim(v.size), upc: realUpc(v.barcode),
      price: round2((Number(v.price) || 0) * (1 + uplift / 100)), qty: Math.round(Number(v.qty)),
    }))
    .sort((a, b) => sizeNum(a.size) - sizeNum(b.size) || a.size.localeCompare(b.size));
  const specifics = [];
  if (brand) specifics.push(['Brand', brand]);
  for (const [k, v] of Object.entries(p.specifics || {})) specifics.push([k, String(v)]);
  if (style) specifics.push(['Style Code', style]);
  const max = Math.min(Number(p.maxPictures) || MAX_PICTURES, MAX_PICTURES);
  return {
    title, description: String(product.descriptionHtml ?? ''), brand, style,
    categoryId: String(p.categoryId || ''), conditionId: Number(p.conditionId) || 1000,
    listingType: p.listingType || 'FixedPriceItem', duration: p.duration || 'GTC', dispatchDays: Number(p.dispatchDays) || 1,
    location: p.location || '', postalCode: p.postalCode || '', country: p.country || 'US', currency: p.currency || 'USD', site: p.site || 'US',
    policies: p.policies || {}, package: p.package || {}, specifics,
    sizeName: p.sizeName || 'Size', sizeValues: [...new Set(variations.map((v) => v.size))],
    pictures: (product.images || []).map((i) => (typeof i === 'string' ? i : i.url)).filter(Boolean).slice(0, max),
    variations,
  };
}

// A title that fits eBay's 80: drop filler words first, then trailing words, never the style code.
const FILLER = ['Mens', "Men's", 'Womens', "Women's", 'Shoes', 'Shoe', 'Sneakers', 'Sneaker', 'Athletic', 'Basketball', 'Running', 'Casual', 'Low', 'High', 'Top'];
export function shorterTitle(title, max = TITLE_MAX) {
  let words = trim(title).split(/\s+/).filter(Boolean);
  const style = styleFromTitle(title);
  const join = () => words.join(' ').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
  const holdsStyle = (w) => style && w.replace(/[()]/g, '').includes(style);
  for (const f of FILLER) {
    if (join().length <= max) break;
    const i = words.findIndex((w) => w === f && !holdsStyle(w));
    if (i >= 0) words.splice(i, 1);
  }
  while (join().length > max && words.length > 1) {
    let i = words.length - 1;
    while (i > 0 && holdsStyle(words[i])) i--;
    if (i < 0 || holdsStyle(words[i])) break;
    words.splice(i, 1);
  }
  const out = join();
  return out.length <= max ? out : out.slice(0, max).trim();
}

// What stops a product from going on eBay, in words a person can act on. `dupSkus` = SKUs used twice
// in Shopify or already on another eBay listing.
export function precheck(product, listing, { dupSkus = new Set() } = {}) {
  const issues = [];
  const add = (code, message, fix) => issues.push({ code, message, fix });
  const imgs = (product.images || []).map((i) => (typeof i === 'string' ? { url: i } : i)).filter((i) => i.url);
  if (!imgs.length) add('no_photo', 'The product has no photo.', 'Add at least 1 photo to the product in Shopify (500 pixels or larger on the longest side).');
  else if (imgs.every((i) => i.width && i.height && Math.max(i.width, i.height) < 500)) add('photo_small', 'Every photo is under 500 pixels.', 'Upload a photo that is at least 500 pixels on the longest side. eBay refuses smaller ones with "Add at least 1 photo".');
  const t = trim(product.title);
  if (t.length > TITLE_MAX) add('title_long', `The title is ${t.length} characters; eBay's limit is ${TITLE_MAX}.`, `Shorten it, for example: "${shorterTitle(t)}"`);
  if (!trim(product.title)) add('no_title', 'The product has no title.', 'Give the product a title in Shopify.');
  if (!textOf(product.descriptionHtml)) add('no_description', 'The product has no description.', 'Add a description to the product in Shopify.');
  const stocked = (product.variants || []).filter((v) => Number(v.qty) > 0);
  if (!stocked.length) add('no_stock', 'No size has stock.', 'It lists once a size is in stock.');
  const noSku = stocked.filter((v) => !trim(v.sku));
  if (noSku.length) add('no_sku', `${noSku.length} size${noSku.length === 1 ? '' : 's'} in stock ${noSku.length === 1 ? 'has' : 'have'} no SKU (${noSku.slice(0, 4).map((v) => v.size || '?').join(', ')}).`, 'Give every size a SKU in Shopify; the SKU is how stock and orders match.');
  const dup = [...new Set(stocked.map((v) => trim(v.sku)).filter((s) => s && dupSkus.has(s)))];
  if (dup.length) add('duplicate_sku', `SKU ${dup.slice(0, 3).join(', ')} is used by more than one size or listing.`, 'Make each SKU unique in Shopify, or end the other listing that uses it.');
  if (listing.variations.length > MAX_VARIATIONS) add('too_many_variations', `${listing.variations.length} sizes; eBay allows ${MAX_VARIATIONS}.`, 'Split the product into two products.');
  const free = stocked.filter((v) => !(Number(v.price) > 0));
  if (free.length) add('price_zero', `${free.length} size${free.length === 1 ? ' has' : 's have'} a price of 0.`, 'Set a price on every size in Shopify.');
  if (!listing.style) add('no_style', 'No style code found in the title.', 'Put the style code in the title, for example "(DD1391-100)"; eBay needs it for Style Code.');
  return issues;
}

// eBay's own refusal -> the same {code,message,fix} shape. `errs` = [{code, short, long}] or a plain message.
export function translateEbayErrors(errs) {
  const list = typeof errs === 'string' ? [{ code: '', long: errs }] : (Array.isArray(errs) ? errs : [errs]);
  const out = [];
  for (const e of list) {
    const code = trim(e?.code);
    const msg = trim(e?.long || e?.short || e?.message);
    if (!msg && !code) continue;
    const m = msg.toLowerCase();
    let hit;
    if (/at least 1 photo|picture.*(500|small|too)|image.*(small|500)|minimum.*500|pixels/.test(m)) hit = ['photo_small', 'eBay refused the photos: none is large enough.', 'Upload a photo of at least 500 pixels on the longest side. This is the "Add at least 1 photo" error.'];
    else if (/title.*(too long|exceed|80|characters)/.test(m) || /\b80\b.*character/.test(m)) hit = ['title_long', 'eBay says the title is too long (limit 80 characters).', 'Shorten the title in Shopify.'];
    else if (/quantity/.test(m)) hit = ['quantity_invalid', 'eBay does not accept the quantity.', 'Check the stock number of each size in Shopify; it must be a whole number of 1 or more.'];
    else if (/price|amount/.test(m)) hit = ['price_invalid', 'eBay does not accept the price.', 'Check the price of each size in Shopify; it must be above 0.'];
    else if (/variation/.test(m) && /(require|must|at least|specific)/.test(m)) hit = ['variation_required', 'eBay needs the sizes set up as variations with a size value on each.', 'Check every size has an option value (for example 9.5) and a SKU in Shopify.'];
    else if (/^21916/.test(code)) hit = ['variation_invalid', msg || `eBay rejected a size on this listing (${code}).`, 'Check each size has a unique SKU and size value in Shopify.'];
    else if (/^21919/.test(code)) hit = ['specifics_invalid', msg || `eBay rejected an item specific (${code}).`, 'Check that value in Shopify, or the specifics on the listing profile.'];
    else hit = [code ? `ebay_${code}` : 'ebay_error', msg || `eBay error ${code}`, 'Not one of the errors we have a fix for yet; the message above is eBay\'s own.'];
    if (!out.some((o) => o.code === hit[0] && o.message === hit[1])) out.push({ code: hit[0], message: hit[1], fix: hit[2] });
  }
  return out;
}

// What the live listing holds vs what we would build now. Photo URLs differ (eBay re-hosts them),
// so pictures are compared by count. A size on eBay that Shopify has at 0 is not drift: eBay keeps it at 0.
export function contentDiff(ebay, built) {
  const fields = [];
  const out = {};
  const collapse = (s) => trim(s).replace(/\s+/g, ' ');
  if (built.title.length <= TITLE_MAX && collapse(ebay.title) !== collapse(built.title)) { fields.push('title'); out.title = { ebay: ebay.title, shopify: built.title }; }
  // An empty Shopify description is never drift (and is never sent): it would blank the listing.
  if (textOf(built.description) && textOf(ebay.description) !== textOf(built.description)) fields.push('description');
  if (Number(ebay.pictureCount) !== built.pictures.length && built.pictures.length > 0) { fields.push('pictures'); out.pictures = { ebay: Number(ebay.pictureCount) || 0, shopify: built.pictures.length }; }
  const have = new Set((ebay.variations || []).map((v) => trim(v.sku)));
  const addSizes = built.variations.filter((v) => !have.has(v.sku)).map((v) => ({ sku: v.sku, size: v.size }));
  if (addSizes.length) { fields.push('sizes'); out.addSizes = addSizes; }
  return { drift: fields.length > 0, fields, ...out };
}

// A cheap fingerprint of what could change a listing (product edit time + which SKUs are in stock),
// so the create pass only re-verifies a product that changed.
export const productKey = (updatedAt, inStockSkus) => hashOf([updatedAt || '', [...inStockSkus].sort()]);

/* -------------------------------- handover -------------------------------- */

// The plan's hand-over criteria as a checklist. All must hold for 7 straight days of shadow.
export function handoverChecklist(f = {}) {
  const days = Number(f.observedDays) || 0;
  const row = (key, label, ok, detail) => ({ key, label, ok: !!ok, detail });
  return [
    row('days', 'Watched for 7 days in shadow', days >= 7, `${days} day${days === 1 ? '' : 's'} so far.`),
    row('stock_drift', 'Stock differences explained down to the listing', (f.qtyDrift || 0) === 0, `${f.qtyDrift || 0} size${f.qtyDrift === 1 ? '' : 's'} still differ after the settle time.`),
    row('price_drift', 'Price differences explained down to the listing', (f.priceDrift || 0) === 0, `${f.priceDrift || 0} size${f.priceDrift === 1 ? '' : 's'} differ and are not kept.`),
    row('content_live', 'Content revise tested live on a small set', (f.contentLive || 0) > 0, `${f.contentLive || 0} live revise${f.contentLive === 1 ? '' : 's'} done.`),
    row('create_live', 'New listing tested live on a small set', (f.createLive || 0) > 0, `${f.createLive || 0} live listing${f.createLive === 1 ? '' : 's'} done.`),
  ];
}

// Listings that a stock push would END: eBay (out-of-stock control off) ends a listing when no size has stock.
// changes = [{ link, qty }]; linksOf(itemId) = every link of that listing.
export function endsByZero(changes, linksOf) {
  const byItem = new Map();
  for (const c of changes) byItem.set(c.link.item_id, [...(byItem.get(c.link.item_id) || []), c]);
  const ends = [];
  for (const [itemId, list] of byItem) {
    const set = new Map(list.map((c) => [c.link.link_key, c.qty]));
    const all = linksOf(itemId) || [];
    if (all.length && all.every((l) => (set.has(l.link_key) ? set.get(l.link_key) : Number(l.ebay_qty) || 0) <= 0)) ends.push(itemId);
  }
  return ends;
}

// ?offset= : empty is 0, a number is floored, anything else is refused (null).
export function pageOffset(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e7 ? Math.floor(n) : null;
}
