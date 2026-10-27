// SHEIN Listings Phase 4 — publish brand-new products: the I/O half (the pure half is
// src/lib/sheinPublish.js). Spec: scratchpad plan/phase4-spec.md; docs/context/shein-listings.md → Phase 4.
// Every read is logged (shein_api_log); image conversion (transform-pic) is logged as an ASSET call;
// the one write — publishOrEdit — is sent by the run job in shein-listing.js, never here.
import crypto from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  getListingCache, setListingCache, getListingProduct, listCategoryMaps, listAttrDefaults, listBrandMaps, listSizeMaps, listingInflight, lastPublishItem,
  productPhotosForSku, getSetting, setSetting, countTransformPicToday, listPublishUnconfirmed, markVariantsPublished, verifySizeMapById, verifySizeMap, setListingPublished, updateListingItem, setVariantsLastError,
} from './db.js';
import { r2Configured, presignUrl, publicUrl, isAllowedPhotoUrl } from './r2.js';
import { planPublish, imagePlan, imageConversions, BOX_PLACEHOLDERS, sizeGroupOf, validateBoxDefaults, templateParts } from '../../src/lib/sheinPublish.js';
import { blocker, spuPayload, stableJson, hashString, BLOCKERS } from '../../src/lib/sheinListings.js';

const H = 3600_000; const DAY = 24 * H;
export const RENDER_VERSION = 'pad1500-white-q88-v1';
export const BOX_KEY = 'shein_box_defaults';

// A stale entry beats none; `fresh` forces a re-read (the run's gates).
async function cached(kind, key, maxAgeMs, fetcher, { fresh = false } = {}) {
  const c = await getListingCache(kind, key);
  if (!fresh && c && Date.now() - new Date(c.fetched_at).getTime() < maxAgeMs) return c.payload;
  try {
    const v = await fetcher();
    await setListingCache(kind, key, v, 'phase 4');
    return v;
  } catch (e) { if (c && !e.notConnected) return c.payload; throw e; }
}

/* --------------------------------- D6 box defaults --------------------------------- */
// app_settings shein_box_defaults = { groups: {adult, youth, child, toddler: {length,width,height,weight}}, confirmed, by, at }.
// Until a person saves them they are the spec's PLACEHOLDERS, unconfirmed — and nothing is published.
export async function readBoxDefaults() {
  try { const v = await getSetting(BOX_KEY); if (v) return JSON.parse(v); } catch { /* fall through */ }
  return { groups: BOX_PLACEHOLDERS, confirmed: false, by: null, at: null };
}
export async function saveBoxDefaults(groups, by) {
  const bad = validateBoxDefaults(groups);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });
  const clean = Object.fromEntries(Object.keys(BOX_PLACEHOLDERS).map((g) => [g, { length: String(groups[g].length), width: String(groups[g].width), height: String(groups[g].height), weight: Number(groups[g].weight) }]));
  const v = { groups: clean, confirmed: true, by, at: new Date().toISOString() };
  await setSetting(BOX_KEY, JSON.stringify(v), by);
  return v;
}

/* --------------------------------- store gates (spec 1A) --------------------------------- */
export async function publishGates({ io, log, fresh = false, brandCodes = [], need = 1 }) {
  const perm = await cached('publish_perm', 'store', H, () => io.sheinPublishPermission(null, log), { fresh });
  const quota = await cached('publish_quota', 'store', H, () => io.sheinPublishQuota(null, log), { fresh });
  const shelf = await cached('shelf_quota', 'store', H, () => io.sheinShelfQuota(null, log), { fresh });
  // A brand may be quota-exempt: read per brand too and take the better answer.
  const brandQuota = {};
  for (const b of [...new Set(brandCodes.filter(Boolean))]) brandQuota[b] = await cached('publish_quota', b, H, () => io.sheinPublishQuota(b, log), { fresh }).catch(() => null);
  const sites = await cached('site_list', 'store', H, () => io.sheinSiteList(log), { fresh });
  const us = (sites || []).map((s) => ({ s, sub: (s.sub_site_list || []).find((x) => x.site_abbr === 'shein-us' && Number(x.site_status) === 1 && /usd/i.test(x.currency || '')) })).find((x) => x.sub);
  const wh = (await io.sheinWarehouses(log).catch(() => [])).filter((w) => String(w.warehouseType) === '1');
  const def = wh.find((w) => [].concat(w.countrySiteDefaultList || []).some((d) => Number(d.defaultFlag) === 1 && /us/i.test(d.countrySiteCode || ''))) || (wh.length === 1 ? wh[0] : null);
  return { perm, quota, shelf, brandQuota, site: us ? { main_site: us.s.main_site } : null, warehouse: def ? { code: def.warehouseCode, name: def.warehouseName } : null, need };
}
export const brandList = (io, log, fresh = false) => cached('brands', 'store', DAY, () => io.sheinBrandList(log), { fresh });
export const categoryTree = (io, log, fresh = false) => cached('category_tree', 'store', DAY, () => io.sheinCategoryTree(log), { fresh });
// The tree → every leaf { categoryId, productTypeId, path }.
export function treeLeaves(tree) {
  const out = [];
  const walk = (nodes, path) => { for (const n of nodes || []) { const p = [...path, n.category_name || String(n.category_id)]; if (n.last_category === true) out.push({ categoryId: Number(n.category_id), productTypeId: n.product_type_id == null ? null : Number(n.product_type_id), path: p.join(' › ') }); walk(n.children, p); } };
  walk(tree, []);
  return out;
}
export const fillFor = (categoryId, io, log, fresh = false) => cached('fill_standard', categoryId, DAY, () => io.sheinFillStandard(categoryId, log), { fresh });
export async function templateFor(ptid, io, log, fresh = false) {
  const data = await cached('attr_template', ptid, 7 * DAY, async () => (await io.sheinAttributeTemplates([Number(ptid)], log)).find((x) => Number(x.product_type_id) === Number(ptid)) || null, { fresh });
  return data;
}
export async function permissionFor(categoryId, attributeId, io, log, fresh = false) {
  const list = await cached('custom_perm', categoryId, DAY, async () => (await io.sheinCustomPermissions([Number(categoryId)], log))
    .filter((x) => Number(x.last_category_id) === Number(categoryId)).map((x) => ({ attribute_id: Number(x.attribute_id), has_permission: Number(x.has_permission) })), { fresh });
  const hit = (list || []).find((x) => Number(x.attribute_id) === Number(attributeId));
  return hit ? Number(hit.has_permission) : null;
}
// Associated-attribute rules (spec 1B-4): re-run while a newly required attribute has a default, ≤ 3 rounds.
export async function assocRequired({ categoryId, productTypeId, defaults, parts, io, log }) {
  const productIds = new Set((parts?.product || []).map((a) => Number(a.attribute_id)));
  const listFor = (rows) => rows.filter((d) => productIds.has(Number(d.attribute_id))).flatMap((d) => (d.value_ids || []).map((v) => ({ attribute_id: Number(d.attribute_id), attribute_value_id: Number(v) })));
  let used = defaults; let out = [];
  for (let round = 0; round < 3; round++) {
    const req = { group_id: '1', category_id: Number(categoryId), product_type_id: Number(productTypeId), attribute_list: listFor(used) };
    const key = hashString(stableJson(req));
    const data = await cached('assoc_rules', key, DAY, () => io.sheinAssocRules(req, log));
    out = (data || []).flatMap((g) => g.link_rule_attribute_list || []).map((a) => ({ attribute_id: Number(a.attribute_id), allowed: [...new Set([...(a.attribute_value_list || []), ...(a.attribute_value_pre_fill_list || [])].map(Number))] }));
    const grown = defaults.filter((d) => out.some((o) => o.attribute_id === Number(d.attribute_id)) && !used.includes(d));
    if (!grown.length) break;
    used = [...used, ...grown];
  }
  return out;
}

/* --------------------------------- photos (spec 2.5) --------------------------------- */
// Fit inside 1500 × 1500 on white, centred, JPEG 88 — never cropped. A source under 600 px on its long side is refused.
export async function padPhoto(buf) {
  const img = await loadImage(buf);
  const long = Math.max(img.width, img.height);
  if (long < 600) throw Object.assign(new Error(`too small (${img.width}×${img.height}; SHEIN needs ≥ 900 px, we upscale from ≥ 600)`), { tooSmall: true });
  const S = 1500; const c = createCanvas(S, S); const g = c.getContext('2d');
  g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, S, S);
  const k = Math.min(S / img.width, S / img.height); const w = Math.round(img.width * k); const h = Math.round(img.height * k);
  g.drawImage(img, Math.round((S - w) / 2), Math.round((S - h) / 2), w, h);
  return c.encode('jpeg', 88);
}
export async function hostOnR2(key, buf) {
  if (!r2Configured()) throw new Error('R2 isn’t configured on the server — photos can’t be hosted for SHEIN.');
  const r = await fetch(presignUrl({ key, method: 'PUT', expiresIn: 300 }), { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: buf, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`R2 PUT failed (${r.status})`);
  return publicUrl(key);
}
// Security M2 (defence in depth): a photo is only fetched over https from our R2 public host or the
// Shopify CDN; a redirect may only stay on the same host (≤ 3); 15 MB cap while streaming; 20 s overall.
export const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
export const SHOPIFY_CDN_HOSTS = ['cdn.shopify.com'];
export function photoSourceAllowed(url) {
  let u; try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  if (SHOPIFY_CDN_HOSTS.includes(u.hostname.toLowerCase())) return true;
  return isAllowedPhotoUrl(u.href);
}
export async function fetchImage(url, { maxBytes = PHOTO_MAX_BYTES, timeoutMs = 20_000, fetchFn = fetch } = {}) {
  if (!photoSourceAllowed(url)) throw new Error('photo isn’t on Shopify’s CDN or our R2 host — not downloaded');
  const signal = AbortSignal.timeout(timeoutMs);
  let cur = new URL(String(url)); let r = null;
  for (let hop = 0; hop <= 3; hop++) {
    r = await fetchFn(cur.href, { signal, redirect: 'manual', headers: { accept: 'image/*' } });
    if (r.status < 300 || r.status >= 400) break;
    const loc = r.headers.get('location');
    const next = loc ? new URL(loc, cur) : null;
    if (!next || next.host !== cur.host || next.protocol !== 'https:' || hop === 3) throw new Error(`photo download redirected away (${r.status}) — not followed`);
    cur = next;
  }
  if (!r.ok) throw new Error(`photo download failed (${r.status})`);
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) throw new Error(`photo is too large (${Math.round(len / 1048576)} MB; the cap is ${Math.round(maxBytes / 1048576)} MB)`);
  const chunks = []; let n = 0;
  if (r.body && typeof r.body.getReader === 'function') {
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.length;
      if (n > maxBytes) { try { await rd.cancel(); } catch { /* ignore */ } throw new Error(`photo is too large (over ${Math.round(maxBytes / 1048576)} MB)`); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`photo is too large (over ${Math.round(maxBytes / 1048576)} MB)`);
  return buf;
}
// Convert the photos a plan needs. Cache kind 'pic', key sha256(source + render version) : image_type.
// → { converted: { 'photo:type': SHEIN url }, errors: [{ photo, reason, sheinMessage }], photoCount, conversions }
// Security H2: at most `shein_transform_cap` (default 500) transform-pic calls per EST day, store-wide.
export const TRANSFORM_CAP_KEY = 'shein_transform_cap';
export const TRANSFORM_CAP_DEFAULT = 500;
export async function readTransformCap() {
  const v = await getSetting(TRANSFORM_CAP_KEY).catch(() => null);
  const n = v == null || String(v).trim() === '' ? NaN : Number(v);   // unset is the default — never 0 (Number(null) is 0)
  return Number.isInteger(n) && n >= 0 ? n : TRANSFORM_CAP_DEFAULT;
}
export async function convertPhotos({ urls, fill, io, log }) {
  const plan = imagePlan(fill);
  const out = { converted: {}, errors: [], photoCount: urls.length, conversions: 0, cached: 0, capReached: null };
  const rendered = new Map();
  let cap = null; let used = 0;
  for (const { photo, type } of imageConversions(plan, urls.length)) {
    const src = urls[photo];
    const key = `${crypto.createHash('sha256').update(`${src}|${RENDER_VERSION}`).digest('hex')}:${type}`;
    const hit = await getListingCache('pic', key);
    if (hit?.payload?.transformed) { out.converted[`${photo}:${type}`] = hit.payload.transformed; out.cached += 1; continue; }
    if (cap == null) { cap = await readTransformCap(); used = await countTransformPicToday(); }
    if (used >= cap) { out.capReached = { cap, used }; break; }   // nothing more converted today (EST)
    used += 1;
    try {
      let hosted = rendered.get(photo);
      if (!hosted) {
        const jpg = await padPhoto(await io.fetchImage(src));
        hosted = await io.hostImage(`shein-publish/${key.split(':')[0]}.jpg`, jpg);
        rendered.set(photo, hosted);
      }
      const info = await io.sheinTransformPic(type, hosted, log);
      out.conversions += 1;
      if (!info?.transformed) { out.errors.push({ photo, type, reason: info?.failure_reason || 'refused', sheinMessage: info?.failure_reason || null }); continue; }
      await setListingCache('pic', key, { transformed: info.transformed, source: src, type, at: new Date().toISOString() }, 'phase 4');
      out.converted[`${photo}:${type}`] = info.transformed;
    } catch (e) {
      if (e.notConnected) throw e;
      out.errors.push({ photo, type, reason: e.tooSmall ? 'too small' : String(e.message).slice(0, 200), sheinMessage: e.sheinMsg || null });
    }
  }
  return out;
}

/* --------------------------------- one product --------------------------------- */
// Read everything fresh and build ONE product's publish plan + body (the dry run and the run share it).
export async function buildPublish(it, { jctx, io, log, fatal }) {
  const d = await getListingProduct(it.shopify_product_id);
  const lg = log({ itemId: it.id });
  if (!d || String(d.product.shopify_product_id).startsWith('shein:')) return { body: null, plan: { op: 'publish', blockers: [blocker('shopify_inactive', { status: 'DELETED' })], sizes: [], skipped: [], notes: [] } };
  const shop = await io.shopifyListingProduct(d.product.shopify_product_id);
  if (shop?.error) throw Object.assign(new Error(`Shopify didn’t answer: ${shop.error}`), { httpStatus: 503 });
  const product = shop?.product ? { ...shop.product, style: shop.product.style || d.product.style } : null;
  if (d.product.spu && d.variants.some((v) => ['sku', 'link', 'published'].includes(v.match))) {
    return { body: null, plan: { op: 'publish', blockers: [blocker('dup_on_shein', { sheinSize: d.product.spu })], notes: [], sizes: [], skipped: [], why: 'already on SHEIN — use add sizes / update' } };
  }
  const excluded = new Set(d.variants.filter((v) => v.excluded).map((v) => v.shopify_variant_id));
  const variants = (product?.variants || []).filter((v) => !excluded.has(v.variantId));
  const groups = [...new Set(variants.map((v) => sizeGroupOf(v.size)).filter(Boolean))];
  // category (D7) + the tree check
  const maps = jctx.categoryMaps || await listCategoryMaps();
  const row = groups.length === 1 ? maps.find((m) => m.shopify_product_type === String(product?.productType || '') && m.size_group === groups[0]) : null;
  let category = null; let suggestion = null;
  const tree = row ? await categoryTree(io, lg).catch((e) => { if (fatal(e)) throw e; return null; }) : null;
  if (row) {
    const leaf = tree ? treeLeaves(tree).find((l) => l.categoryId === Number(row.category_id)) : null;
    category = { categoryId: Number(row.category_id), productTypeId: Number(leaf?.productTypeId ?? row.product_type_id), path: row.category_path || leaf?.path || null,
      treeOk: !tree ? undefined : !!leaf && Number(leaf.productTypeId) === Number(row.product_type_id) };
  } else if (product?.image) {
    // S8: one suggestion per product a day (a read, but no need to ask on every dry run)
    const s = await cached('cat_suggest', it.shopify_product_id, DAY, () => io.sheinCategorySuggest(product.images?.[0]?.url || product.image, String(product.title || '').slice(0, 1000), lg)).catch((e) => { if (fatal(e)) throw e; return []; });
    suggestion = (s || []).sort((a, b) => (a.order ?? 9) - (b.order ?? 9)).slice(0, 3).map((x) => String(x.categoryId)).join(', ') || null;
  }
  const fill = category ? await fillFor(category.categoryId, io, lg).catch((e) => { if (fatal(e)) throw e; return null; }) : null;
  const template = category ? await templateFor(category.productTypeId, io, lg).catch((e) => { if (fatal(e)) throw e; return null; }) : null;
  const parts = template ? templateParts(template) : null;
  const attrDefaults = category ? await listAttrDefaults(category.productTypeId) : [];
  const assoc = category && template ? await assocRequired({ categoryId: category.categoryId, productTypeId: category.productTypeId, defaults: attrDefaults, parts, io, log: lg }).catch((e) => { if (fatal(e)) throw e; return []; }) : [];
  const permission = category && parts?.size ? await permissionFor(category.categoryId, parts.size.attributeId, io, lg).catch(() => null) : null;
  // brand (D5)
  const bm = (jctx.brandMaps || await listBrandMaps()).find((b) => b.vendor === String(product?.vendor || '').trim().toLowerCase());
  const brands = await brandList(io, lg).catch(() => null);
  // N2: the brand list unread → listed null ("not read yet"), never authorised by default
  const brand = bm ? { code: bm.brand_code, name: bm.brand_name, noBrand: !!bm.no_brand, listed: !bm.brand_code ? true : !brands ? null : brands.some((b) => b.brand_code === bm.brand_code) } : null;
  // S7: the brand's own quota (a brand may be quota-exempt), cached 1 h like the store's
  const brandQuota = bm?.brand_code ? await cached('publish_quota', bm.brand_code, H, () => io.sheinPublishQuota(bm.brand_code, lg)).catch(() => null) : null;
  // sizes, SKUs, prices
  const sizeMaps = jctx.sizeMaps || await listSizeMaps();
  const customValues = (parts?.size?.values || []).filter((v) => v.custom).map((v) => v.label);
  const skus = [...new Set(variants.map((v) => String(v.sku || '').trim()).filter(Boolean))];
  const taken = skus.length ? await io.sheinSkusTaken(skus, lg) : new Set();
  const skuCounts = new Map(); for (const v of variants) { const k = String(v.sku || '').trim(); if (k) skuCounts.set(k, (skuCounts.get(k) || 0) + 1); }
  for (const v of d.variants) if ((v.blockers || []).some((b) => b.code === 'dup_seller_sku')) skuCounts.set(v.seller_sku, 2);
  const market = await io.marketTargets([product]).catch(() => new Map());
  const box = jctx.box || await readBoxDefaults();
  const inFlight = (await listingInflight()).some((x) => x.op === 'publish' && x.shopify_product_id === it.shopify_product_id && x.id !== it.id);
  // re-review G1: another publish of this product SHEIN never confirmed → no new publish until it is resolved
  const other = (await listPublishUnconfirmed()).find((x) => x.shopify_product_id === it.shopify_product_id && String(x.id) !== String(it.id));
  const unconfirmed = other ? { itemId: Number(other.id), jobId: Number(other.job_id) } : null;
  const last = await lastPublishItem(it.shopify_product_id);
  const rejectedAt = last && last.id !== it.id && last.status === 'failed' && (last.blockers || []).some((b) => b.code === 'review_rejected') ? new Date(last.updated_at) : null;
  const rejected = rejectedAt && !(d.product.publish_again_at && new Date(d.product.publish_again_at) > rejectedAt) ? { failedReason: (last.blockers || []).find((b) => b.code === 'review_rejected')?.params?.failedReason || null } : null;
  const input = { product, productRow: d.product, gates: jctx.gates || {}, category, suggestion, fill, template, assoc, attrDefaults, brand, brandQuota, maps: sizeMaps, permission, customValues, market, box, taken, takenChecked: true, inFlight, unconfirmed, rejected, skuCounts };
  // Photos only when nothing else blocks (conversions are SHEIN asset calls)
  const pre = planPublish({ ...input, images: null, unknown: ['photos'] });
  const hard = pre.plan.blockers.filter((b) => !['note', 'review'].includes(BLOCKERS[b.code]?.level));
  if (hard.length) { pre.plan.checklist = pre.checklist; return { body: null, plan: pre.plan, variantIds: [] }; }
  // Security H2: only a dry run an admin / Connect-integrations holder started converts photos (R2 upload +
  // SHEIN transform-pic); a PH dry run stops here — the photo line stays "not read yet", nothing is sendable.
  if (!jctx.convertPhotos) {
    pre.plan.notes.push(blocker('photos_need_priv'));
    pre.plan.checklist = pre.checklist;
    pre.plan.photos = { converted: false, why: 'needs_priv' };
    return { body: null, plan: pre.plan, variantIds: [] };
  }
  let urls = [];
  if (d.product.use_ph_photos && product?.style) urls = (await productPhotosForSku(product.style)).map((p) => p.url);
  if (!urls.length) urls = (product?.images || []).map((i) => i.url);
  const images = await convertPhotos({ urls: urls.slice(0, 11), fill, io, log: lg });
  const { body, plan, checklist } = planPublish({ ...input, images });
  plan.checklist = checklist;
  plan.photos = { source: d.product.use_ph_photos && urls.length ? 'ph_edited' : 'shopify', count: urls.length, converted: images.conversions, cached: images.cached };
  return { body, plan, variantIds: plan.sizes.map((z) => z.variantId) };
}

// publishOrEdit's answer (spec 4.1): sent = success true + spu_name + version; success true without
// them = unknown (looked up after ≥ 5 min); success false / pre_valid / mcc type 2 = refused (mapped).
export function readPublishAnswer(info, plan) {
  const said = [...(info?.pre_valid_result || []).flatMap((x) => (x.messages || []).map((m) => ({ module: x.module || x.form || null, message: m }))),
    ...(info?.mcc_valid_result || []).filter((x) => x?.message).map((x) => ({ module: Number(x.type) === 2 ? 'mcc (blocked)' : 'mcc (warning)', message: x.message, block: Number(x.type) === 2 }))];
  if (info?.success !== true) return { kind: 'refused', message: said.map((x) => x.message).join(' | ') || 'SHEIN refused the product (success: false)', module: said[0]?.module || null, mapped: mapRefusal(said) };
  if (!info.spu_name || !info.version) return { kind: 'unknown', message: 'SHEIN said OK but gave no product number — we look it up before trying again.' };
  const mine = new Set((plan?.sizes || []).map((z) => z.sku));
  const skc = (info.skc_list || [])[0] || {};
  const skuCodes = (info.skc_list || []).flatMap((c) => (c.sku_list || []).filter((x) => mine.has(x.supplier_sku)).map((x) => ({ skc: c.skc_name, skuCode: x.sku_code, sellerSku: x.supplier_sku })));
  const notes = said.map((x) => blocker('shein_note', { sheinMessage: x.message, module: x.module }));
  for (const f of [].concat(info.filtered_result || [])) if (f) notes.push(blocker('shein_note', { sheinMessage: `SHEIN dropped: ${f.scene || ''}${f.scene ? ': ' : ''}${f.message || JSON.stringify(f).slice(0, 200)}`, module: 'filtered_result' }));
  return { kind: 'sent', spu: String(info.spu_name), version: String(info.version), skc: skc.skc_name || null, skuCodes, notes };
}
// SHEIN's pre-check module / form → a better blocker (spec 4.1); SHEIN's words always kept.
export function mapRefusal(said) {
  const t = said.map((x) => `${x.module || ''} ${x.message || ''}`).join(' ');
  if (/图片|image|picture/i.test(t)) return 'image_rejected';
  if (/属性|attribute/i.test(t)) return 'missing_attr';
  if (/标题|name|title/i.test(t)) return 'title_too_long';
  if (/brand|品牌/i.test(t)) return 'brand_not_authorized';
  if (/supplier_sku|货号|repeat|重复/i.test(t)) return 'seller_sku_taken';
  if (/price|价格/i.test(t)) return 'no_price';
  return 'shein_prevalid';
}

// SHEIN approved a publish: read spu-info, our sizes become 'published', the product is OURS
// (synced_hash), size maps verified, one stock step, then compliance (spec 1B-12).
export async function publishApproved(item, { io, recompute }) {
  const log = { source: 'review', jobId: item.job_id, itemId: item.id, spu: item.spu, by: 'SHEIN review', dry: false };
  const info = await io.sheinSpuInfo(item.spu, log);
  const payload = spuPayload(info, { stock: await io.lastWalkStock().catch(() => new Map()) });
  const rows = payload?.rows || [];
  const plan = item.plan || {};
  const sizes = (plan.sizes || []).map((z) => ({ z, row: rows.find((r) => r.sellerSku === z.sku) }));
  if (!payload || sizes.some((x) => !x.row)) return { waiting: true };
  await markVariantsPublished(sizes.map(({ z, row }) => ({ variantId: z.variantId, spu: item.spu, skc: row.skc, shein_sku: row.sheinSku, seller_sku: row.sellerSku, shein_size: row.size, value_id: row.sizeValueId })));
  for (const { z, row } of sizes) {
    if (z.mapId) await verifySizeMapById(z.mapId, z.kind === 'custom' ? row.sizeValueId : null);
    else if (plan.category?.id) await verifySizeMap({ category_id: Number(plan.category.id), attribute_id: Number(plan.sizeAttributeId) || 0, size_key: z.sizeKey, attribute_value_id: row.sizeValueId ?? z.valueId, shein_label: row.size }, 'SHEIN approval');
  }
  await setVariantsLastError(item.variant_ids || [], null);
  const d = await getListingProduct(item.shopify_product_id);
  await setListingPublished(item.shopify_product_id, { spu: item.spu, version: item.version, syncedHash: d?.product?.shopify_hash || 'published' });   // OURS from now on (D11)
  await setListingCache('spu', item.spu, payload, `publish ${item.job_id}`);
  const list = (await getListingCache('spu_list', 'current'))?.payload || [];
  if (!list.includes(item.spu)) await setListingCache('spu_list', 'current', [...list, item.spu], `publish ${item.job_id}`);
  await updateListingItem(item.id, { status: 'done', checkedNow: true, documentState: 2, error: null });
  await recompute();
  let stock = null;
  try { stock = await io.stockStep(item.spu); } catch (e) { stock = { error: e.message }; }
  // compliance (a person fixes it in Seller Center)
  const notes = [];
  try {
    const skc = rows[0]?.skc;
    const data = skc ? await io.sheinCompliance([skc], log) : [];
    for (const g of data || []) for (const x of g.items || []) if (Number(x.isRequired) === 1 && [0, 3].includes(Number(x.reviewState))) notes.push(blocker('compliance_missing', { name: x.certificateTypeName || x.certificateTypeCode || null }));
  } catch (e) { notes.push(blocker('shein_note', { sheinMessage: `compliance list unread: ${e.message}` })); }
  await updateListingItem(item.id, { response: { ...(item.response || {}), stock_step: stock }, blockers: notes });
  return { done: true, stock, compliance: notes.length };
}
