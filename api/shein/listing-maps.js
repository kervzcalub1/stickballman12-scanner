// GET  /api/shein/listing-maps?type=size -> { ok, type, maps, usage, categories }
//   maps       shein_size_map rows (what a person set)
//   usage      every (SHEIN category, our size) Shopify needs: counts, what we'd send today, the
//              suggested custom spelling (D1: SHEIN's own pattern; a custom value already in the store wins)
//   categories per SHEIN category we're in: size attribute, custom sizes allowed, SHEIN's size list
// POST /api/shein/listing-maps?type=size
//   { action:'set', categoryId, attributeId, sizeKey, attributeValueId } — use one of SHEIN's sizes
//       (refused unless it IS the same size: compareSize; a different number is never accepted)
//   { action:'set', categoryId, attributeId, sizeKey, customValue }      — confirm a custom spelling
//       (≤ 50 characters, printable ASCII with single spaces, no emoji; not a case/spacing look-alike
//       of a store value nor one of SHEIN's own sizes; only in a category + size field where SHEIN
//       allows custom sizes — has_permission 1). Store-wide on SHEIN, so a person confirms it once.
//       Optional footLength (size-chart products).
//   { action:'clear', id }
//   -> { ok, map | cleared, recomputed }
// DB ONLY — never a SHEIN write: a custom size reaches SHEIN only with a later phase's Run. PH + admin.
// The size map is the only map in Phase 1 (category / attribute maps come with publishing, Phase 4).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { hasPrivilege } from '../_lib/buycart.js';
import {
  listCategoryMaps, saveCategoryMap, deleteCategoryMap, listAttrDefaults, saveAttrDefault, deleteAttrDefault, listBrandMaps, saveBrandMap, deleteBrandMap,
} from '../_lib/db.js';
import { treeLeaves, readBoxDefaults, saveBoxDefaults } from '../_lib/shein-publish.js';
import { SIZE_GROUPS, templateParts, BOX_PLACEHOLDERS, isKnownBrand, KNOWN_BRANDS } from '../../src/lib/sheinPublish.js';
import { dbConfigured, listSizeMaps, saveSizeMap, deleteSizeMap, listingSizeUsage, listListingCache, getListingCache, latestListingJob } from '../_lib/db.js';
import { recomputeStored, readSizeLists } from '../_lib/shein-listing.js';
import { validateCustomText, customTextConflict, suggestCustomSpelling, sizeKey } from '../../src/lib/sheinListings.js';
import { compareSize } from '../../src/lib/sheinCheck.js';

// "9.5|W" → "9.5W" (what a person reads; also what compareSize reads).
export const keyToSize = (k) => { const [n, g] = String(k || '').split('|'); return g === 'M' ? n : `${n}${g || ''}`; };
const int = (v) => (v == null || v === '' ? null : (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN));

async function sizeWorld() {
  const keep = (await getListingCache('spu_list', 'current'))?.payload || [];
  const payloads = (await listListingCache('spu', keep)).map((r) => r.payload).filter(Boolean);
  const sizes = await readSizeLists(payloads, { fetch: false });
  const cats = new Map();
  for (const p of payloads) {
    if (p.categoryId == null || cats.has(p.categoryId)) continue;
    const tpl = p.productTypeId != null ? sizes.templates.get(Number(p.productTypeId)) : null;
    const attributeId = p.sizeAttrId ?? tpl?.attributeId ?? null;
    const perm = sizes.permissions.get(`${p.categoryId}|${attributeId}`);
    cats.set(p.categoryId, { categoryId: p.categoryId, productTypeId: p.productTypeId, attributeId, hasPermission: perm == null ? null : perm,
      hasSizeTable: !!p.hasSizeTable, sheinSizes: tpl?.values || null });
  }
  return { cats, customValues: sizes.customValues };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const qs = new URL(req.url, 'http://x').searchParams;
  const type = qs.get('type') || 'size';
  if (['category', 'attr', 'brand', 'box'].includes(type)) return phase4Maps(req, res, user, type, qs);
  if (type !== 'size') return send(res, 400, { ok: false, error: 'Unknown map type (size | category | attr | brand | box).' });

  if (req.method === 'GET') {
    const [maps, usage, world] = await Promise.all([listSizeMaps(), listingSizeUsage(), sizeWorld()]);
    const out = usage.map((u) => {
      const c = world.cats.get(Number(u.category_id)) || null;
      const size = keyToSize(u.size_key);
      return { ...u, category_id: Number(u.category_id), size, attributeId: c?.attributeId ?? null, hasPermission: c?.hasPermission ?? null,
        suggestion: u.size_key ? suggestCustomSpelling(size, (c?.sheinSizes || []).map((v) => v.label), world.customValues) : null,
        map: maps.find((m) => Number(m.category_id) === Number(u.category_id) && m.size_key === u.size_key) || maps.find((m) => Number(m.category_id) === 0 && m.size_key === u.size_key) || null };
    });
    return send(res, 200, { ok: true, type, maps, usage: out, categories: [...world.cats.values()], customValues: world.customValues });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const b = await getJsonBody(req);
  const by = user.name || user.username || '';
  const recompute = async () => ((await latestListingJob('snapshot', 'done')) ? (await recomputeStored(), true) : false);

  if (b.action === 'clear') {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id < 1) return send(res, 400, { ok: false, error: 'Which mapping?' });
    const n = await deleteSizeMap(id);
    return send(res, 200, { ok: true, cleared: n, recomputed: n ? await recompute() : false });
  }
  if (b.action !== 'set') return send(res, 400, { ok: false, error: 'Unknown action.' });
  const categoryId = int(b.categoryId ?? 0); const attributeId = int(b.attributeId ?? 0);
  if (Number.isNaN(categoryId) || Number.isNaN(attributeId)) return send(res, 400, { ok: false, error: 'Category / attribute must be SHEIN ids.' });
  const key = String(b.sizeKey || '').trim();
  if (!/^\d{1,2}(\.\d)?\|[MWYC]$/.test(key) || sizeKey(keyToSize(key)) !== key) return send(res, 400, { ok: false, error: 'That isn’t one of our sizes (e.g. 9.5|W).' });
  const size = keyToSize(key);
  let footLength = null;
  if (b.footLength != null && b.footLength !== '') {
    footLength = Number(b.footLength);
    if (!Number.isFinite(footLength) || footLength <= 0 || footLength > 100 || Math.round(footLength * 100) !== footLength * 100) return send(res, 400, { ok: false, error: 'Foot length: a positive number of cm, at most 2 decimals.' });
  }
  const note = b.note == null ? null : String(b.note).slice(0, 300);
  const hasValue = b.attributeValueId != null && b.attributeValueId !== '';
  const hasCustom = b.customValue != null && b.customValue !== '';
  if (hasValue === hasCustom) return send(res, 400, { ok: false, error: 'Pick ONE: a SHEIN size, or a custom spelling.' });

  if (hasCustom) {
    const text = String(b.customValue);
    const bad = validateCustomText(text);
    if (bad) return send(res, 400, { ok: false, error: bad });
    if (compareSize(text, size) !== 'ok') return send(res, 400, { ok: false, error: `“${text}” doesn’t read as size ${size} — a custom size must say the same size (e.g. US${size}).` });
    // SHEIN allows custom values per store + category + size attribute (review M1): never "any
    // category", and only where SHEIN said has_permission 1 for that exact attribute.
    if (!categoryId || !attributeId) return send(res, 400, { ok: false, error: 'A custom size is confirmed per SHEIN category and size field — pick the category (SHEIN allows custom sizes category by category).' });
    const world = await sizeWorld();
    const cat = world.cats.get(categoryId);
    if (!cat || Number(cat.attributeId) !== attributeId) return send(res, 409, { ok: false, error: 'SHEIN’s size field for this category hasn’t been read yet (or isn’t that one) — re-read Shopify + SHEIN.' });
    if (cat.hasPermission !== 1) return send(res, 400, { ok: false, error: `SHEIN doesn’t allow custom sizes in category ${categoryId}${cat.hasPermission == null ? ' (not asked yet — Ask SHEIN first)' : ''}.` });
    const clash = customTextConflict(text, { values: cat.sheinSizes || [], customValues: world.customValues });
    if (clash) return send(res, 400, { ok: false, error: clash });
    const map = await saveSizeMap({ category_id: categoryId, attribute_id: attributeId, size_key: key, custom_value: text, shein_label: text, foot_length: footLength, source: 'custom_created', note }, by);
    return send(res, 200, { ok: true, map, recomputed: await recompute() });
  }
  const valueId = int(b.attributeValueId);
  if (!valueId) return send(res, 400, { ok: false, error: 'That isn’t a SHEIN size id.' });
  const world = await sizeWorld();
  const cat = world.cats.get(categoryId);
  const value = cat?.sheinSizes?.find((v) => Number(v.id) === valueId);
  if (!value) return send(res, 409, { ok: false, error: 'That size isn’t in SHEIN’s size list for this category (or the list hasn’t been read yet — re-read Shopify + SHEIN).' });
  if (!['ok', 'ok_suffix', 'check_group'].includes(compareSize(value.label, size))) {
    return send(res, 400, { ok: false, error: `SHEIN’s “${value.label}” is a different size than ${size} — we never list a size as another one.` });
  }
  const map = await saveSizeMap({ category_id: categoryId, attribute_id: attributeId || cat.attributeId || 0, size_key: key, attribute_value_id: valueId, shein_label: value.label, foot_length: footLength, source: value.custom ? 'custom_created' : 'person', note }, by);
  return send(res, 200, { ok: true, map, recomputed: await recompute() });
}

/* ------------------------------ Phase 4 maps (DB only) ------------------------------ */
// GET  ?type=category -> { ok, maps, leaves:[{categoryId, productTypeId, path}] | null (tree not read yet), groups, usage:[{productType, sizeGroup, products}] }
// POST ?type=category { action:'set', productType, sizeGroup, categoryId, suggestion? } — must be a LEAF of the cached tree (its
//        product_type_id is taken from the tree) · { action:'clear', productType, sizeGroup }
// GET  ?type=attr&productTypeId= -> { ok, defaults, template:{ attributes:[{attributeId, name, type, mode, status, inputNum, dataDimension, values:[{id,label}]}], main, mainStatus } | null }
// POST ?type=attr { action:'set', productTypeId, attributeId, valueIds?, extraValues? } — values must be in the template · { action:'clear', … }
//      { action:'seed', productTypeId, spu } → proposed defaults from one of OUR approved SHEIN products (spu-info, read only) — NOT saved
// GET  ?type=brand -> { ok, maps, brands (SHEIN's list, cached) | null, vendors }
// POST ?type=brand { action:'set', vendor, brandCode } — must be in SHEIN's current brand list · { action:'clear', vendor }
//      { action:'no_brand', vendor } — a person marks a GENERIC vendor "no brand" (refused for a known brand)
// GET  ?type=box -> { ok, box: { groups, confirmed, by, at }, placeholders }
// POST ?type=box { groups } — D6: admin or Connect integrations; saving CONFIRMS them (unconfirmed placeholders block publishing)
// Security L1: only these fields of SHEIN's category suggestion are stored (never an arbitrary client object).
function cleanSuggestion(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const num = (v) => (v == null || v === '' || !Number.isSafeInteger(Number(v)) ? null : Number(v));
  const out = { categoryId: num(x.categoryId), order: num(x.order), vote: num(x.vote), path: x.path == null ? null : String(x.path).slice(0, 500) };
  return Object.values(out).some((v) => v != null) ? out : null;
}
async function phase4Maps(req, res, user, type, qs) {
  const by = user.name || user.username || '';
  const { getListingCache, listingPublishTypeUsage, listingVendorUsage } = await import('../_lib/db.js');
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });   // security L1
  if (type === 'box') {
    if (req.method === 'GET') return send(res, 200, { ok: true, box: await readBoxDefaults(), placeholders: BOX_PLACEHOLDERS });
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
    const admin = user.role === 'admin' || user.role === 'superadmin';
    if (!admin && !(await hasPrivilege(user, 'connect_integrations'))) return send(res, 403, { ok: false, error: 'This needs an admin, or the “Connect integrations” privilege.' });
    const b = await getJsonBody(req);
    try { return send(res, 200, { ok: true, box: await saveBoxDefaults(b.groups, by) }); } catch (e) { return send(res, e.status || 500, { ok: false, error: e.message }); }
  }
  if (type === 'category') {
    const tree = (await getListingCache('category_tree', 'store'))?.payload || null;
    const leaves = tree ? treeLeaves(tree) : null;
    if (req.method === 'GET') {
      const usage = await listingPublishTypeUsage();
      return send(res, 200, { ok: true, maps: await listCategoryMaps(), leaves, groups: SIZE_GROUPS, usage: usage.map((u) => ({ productType: u.product_type, products: u.n })) });
    }
    const b = await getJsonBody(req);
    const productType = String(b.productType ?? '').trim().slice(0, 200);
    const sizeGroup = String(b.sizeGroup || '');
    if (!SIZE_GROUPS.includes(sizeGroup)) return send(res, 400, { ok: false, error: `sizeGroup: one of ${SIZE_GROUPS.join(', ')}.` });
    if (b.action === 'clear') return send(res, 200, { ok: true, cleared: await deleteCategoryMap(productType, sizeGroup) });
    if (b.action !== 'set') return send(res, 400, { ok: false, error: 'Unknown action.' });
    if (!leaves) return send(res, 409, { ok: false, error: 'SHEIN’s category tree hasn’t been read yet — an admin reads it (listing-meta ?tree=1&refresh=1) or run a publish dry run.' });
    const leaf = leaves.find((l) => l.categoryId === Number(b.categoryId));
    if (!leaf || leaf.productTypeId == null) return send(res, 400, { ok: false, error: 'That isn’t a last-level SHEIN category (SHEIN only takes products in a leaf).' });
    return send(res, 200, { ok: true, map: await saveCategoryMap({ productType, sizeGroup, categoryId: leaf.categoryId, productTypeId: leaf.productTypeId, categoryPath: leaf.path, suggestion: cleanSuggestion(b.suggestion) }, by) });
  }
  if (type === 'attr') {
    const body = req.method === 'POST' ? await getJsonBody(req) : null;
    const ptid = Number(req.method === 'GET' ? qs.get('productTypeId') : body?.productTypeId);
    if (!Number.isSafeInteger(ptid) || ptid < 1) return send(res, 400, { ok: false, error: 'productTypeId?' });
    const template = (await getListingCache('attr_template', ptid))?.payload || null;
    const parts = template ? templateParts(template) : null;
    const describe = (a) => ({ attributeId: Number(a.attribute_id), name: a.attribute_name_en || a.attribute_name || null, type: Number(a.attribute_type), mode: Number(a.attribute_mode),
      status: Number(a.attribute_status), inputNum: Number(a.attribute_input_num) || 0, dataDimension: a.data_dimension == null ? 1 : Number(a.data_dimension),
      values: (a.attribute_value_info_list || []).map((v) => ({ id: Number(v.attribute_value_id), label: v.attribute_value_en || v.attribute_value })) });
    if (req.method === 'GET') {
      return send(res, 200, { ok: true, defaults: await listAttrDefaults(ptid), template: parts ? { attributes: parts.product.map(describe), main: parts.main ? describe(parts.main) : null, mainStatus: parts.mainStatus } : null });
    }
    if (body.action === 'clear') return send(res, 200, { ok: true, cleared: await deleteAttrDefault(ptid, Number(body.attributeId)) });
    if (body.action === 'seed') {
      // read-only: one of OUR approved SHEIN products of this type → the values it carries, for a person to review
      const spu = String(body.spu || '').trim();
      if (!/^[A-Za-z0-9_-]{3,60}$/.test(spu)) return send(res, 400, { ok: false, error: 'That isn’t a SHEIN SPU code.' });
      const { sheinSpuInfoLogged } = await import('../_lib/shein.js');
      try {
        const info = await sheinSpuInfoLogged(spu, { source: 'attr seed', spu, by });
        if (Number(info?.productTypeId) !== ptid) return send(res, 400, { ok: false, error: `${spu} is product type ${info?.productTypeId ?? '?'}, not ${ptid}.` });
        const product = new Set((parts?.product || []).map((a) => Number(a.attribute_id)));
        const proposed = new Map();
        for (const a of info.productAttributeInfoList || []) {
          const id = Number(a.attributeId); if (parts && !product.has(id)) continue;   // sale attributes are mixed in — drop them
          const x = proposed.get(id) || { attributeId: id, name: (a.attributeMultiList || [])[0]?.attributeName || null, valueIds: [], extraValues: [] };
          if (a.attributeValueId != null) x.valueIds.push(Number(a.attributeValueId));
          if (a.attributeValue) x.extraValues.push(String(a.attributeValue));
          proposed.set(id, x);
        }
        return send(res, 200, { ok: true, proposed: [...proposed.values()], saved: false });
      } catch (e) { return send(res, 502, { ok: false, error: `SHEIN: ${e.message}` }); }
    }
    if (body.action !== 'set') return send(res, 400, { ok: false, error: 'Unknown action.' });
    if (!parts) return send(res, 409, { ok: false, error: 'SHEIN’s attribute template for this product type hasn’t been read yet (listing-meta ?category=… or a publish dry run).' });
    const a = parts.product.find((x) => Number(x.attribute_id) === Number(body.attributeId));
    if (!a) return send(res, 400, { ok: false, error: 'That isn’t a product attribute of this SHEIN product type.' });
    const valueIds = (Array.isArray(body.valueIds) ? body.valueIds : []).map(Number).filter(Number.isSafeInteger);
    const extraValues = (Array.isArray(body.extraValues) ? body.extraValues : []).map((x) => String(x).trim().slice(0, 100)).filter(Boolean);
    const known = new Set((a.attribute_value_info_list || []).map((v) => Number(v.attribute_value_id)));
    if (valueIds.some((v) => !known.has(v))) return send(res, 400, { ok: false, error: 'A value isn’t in SHEIN’s list for this attribute.' });
    const mode = Number(a.attribute_mode);
    if (mode === 3 && valueIds.length !== 1) return send(res, 400, { ok: false, error: 'Pick exactly one value.' });
    if (mode === 1 && (!valueIds.length || (Number(a.attribute_input_num) && valueIds.length > Number(a.attribute_input_num)))) return send(res, 400, { ok: false, error: `Pick 1 to ${a.attribute_input_num || 'any'} values.` });
    if (mode === 0 && extraValues.length !== 1) return send(res, 400, { ok: false, error: 'Type one value.' });
    if (mode === 4 && (!valueIds.length || valueIds.length !== extraValues.length)) return send(res, 400, { ok: false, error: 'One amount per value.' });
    if (mode === 4 && Number(a.attribute_type) === 3 && extraValues.reduce((n, x) => n + Number(x), 0) !== 100) return send(res, 400, { ok: false, error: 'The amounts must add up to 100.' });
    return send(res, 200, { ok: true, default: await saveAttrDefault({ productTypeId: ptid, attributeId: Number(a.attribute_id), valueIds, extraValues }, by) });
  }
  // brand
  const brands = (await getListingCache('brands', 'store'))?.payload || null;
  if (req.method === 'GET') {
    const vendors = await listingVendorUsage();
    return send(res, 200, { ok: true, maps: await listBrandMaps(), brands, vendors: vendors.map((v) => ({ vendor: v.vendor, products: v.n, knownBrand: isKnownBrand(v.vendor) })), knownBrands: KNOWN_BRANDS });
  }
  const b = await getJsonBody(req);
  const vendor = String(b.vendor || '').trim().toLowerCase().slice(0, 200);
  if (!vendor) return send(res, 400, { ok: false, error: 'Which vendor?' });
  if (b.action === 'clear') return send(res, 200, { ok: true, cleared: await deleteBrandMap(vendor) });
  if (b.action === 'no_brand') {
    // D5 (review F2): only a real generic product goes up without a brand — never a known brand
    if (isKnownBrand(vendor)) return send(res, 400, { ok: false, error: `“${vendor}” is a known brand — it can’t go up unbranded. Map it to its SHEIN brand (an admin applies for it in Seller Center if SHEIN doesn’t list it).` });
    return send(res, 200, { ok: true, map: await saveBrandMap({ vendor, noBrand: true }, by) });
  }
  if (b.action !== 'set') return send(res, 400, { ok: false, error: 'Unknown action.' });
  if (!brands) return send(res, 409, { ok: false, error: 'SHEIN’s brand list hasn’t been read yet (listing-meta ?brands=1&refresh=1, or a publish dry run).' });
  const hit = brands.find((x) => x.brand_code === String(b.brandCode || ''));
  if (!hit) return send(res, 400, { ok: false, error: 'That brand isn’t in SHEIN’s brand list for our store (an admin applies for it in Seller Center).' });
  return send(res, 200, { ok: true, map: await saveBrandMap({ vendor, brandCode: hit.brand_code, brandName: hit.brand_name }, by) });
}

