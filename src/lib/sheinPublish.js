// SHEIN Listings Phase 4 — publish a brand-new product (publishOrEdit, no spu_name). PURE: the server
// (api/_lib/shein-publish.js) reads SHEIN + Shopify and hands everything in; this builds the EXACT
// body, the plan a person reads and the 18-line requirements checklist (the drawer's, from the
// server now). Spec: scratchpad plan/phase4-spec.md (API specialist, 2026-10-27); docs/shein-listings-plan.md
// §3 Phase 4, §4.2 blockers 11–19, D4/D5/D6/D7/D12. No I/O, no clock — it runs in the browser too.
import { parseSize } from './sheinCheck.js';
import { blocker, BLOCKERS, listingSyncGate, resolveSize, validateCustomText, customTextConflict, sheinNewSizePrice, templateSizes, sizeSort, renderBlocker } from './sheinListings.js';

const trim = (v) => String(v ?? '').trim();
// shopify_inactive is a NOTE on the list (the product reads "Not listing"), but it never publishes (2026-10-28).
const isBlocking = (b) => b.code === 'shopify_inactive' || !['note', 'review'].includes(BLOCKERS[b.code]?.level);
// SHEIN's own range (doc 3002018 custom-value note: [\uD83C-\uDBFF\uDC00-\uDFFF\u2600-\u27ff]) + variation selectors — review S3
const EMOJI_ALL = /[\u{1F000}-\u{1FFFF}\u{10000}-\u{10FFFF}\u2600-\u27FF\uFE0F]|[\uD800-\uDFFF]/gu;

/* --------------------------------- inputs --------------------------------- */

// D6 placeholders — a person must CONFIRM them (app_settings shein_box_defaults) before any publish.
export const BOX_PLACEHOLDERS = {
  adult: { length: '33', width: '21', height: '12', weight: 1400 },
  youth: { length: '30', width: '19', height: '11', weight: 1000 },
  child: { length: '27', width: '17', height: '10', weight: 800 },
  toddler: { length: '24', width: '16', height: '9', weight: 600 },
};
export const SIZE_GROUPS = ['adult', 'women', 'youth', 'child', 'toddler'];
// D5 (review F2): vendors that ARE brands — never "no brand" (an unbranded Nike is an IP problem). Data, grow it.
export const KNOWN_BRANDS = ['nike', 'jordan', 'air jordan', 'adidas', 'yeezy', 'new balance', 'puma', 'reebok', 'asics', 'converse', 'vans', 'under armour', 'saucony', 'hoka',
  'hoka one one', 'on', 'on running', 'salomon', 'crocs', 'ugg', 'timberland', 'fila', 'skechers', 'mizuno', 'brooks', 'balenciaga', 'gucci', 'off-white', 'fear of god',
  'essentials', 'supreme', 'bape', 'a bathing ape', 'travis scott', 'stussy', 'dr. martens', 'birkenstock', 'clarks', 'merrell', 'the north face', 'champion', 'diadora',
  'onitsuka tiger', 'li-ning', 'anta', 'kith', 'golden goose', 'alexander mcqueen', 'louis vuitton', 'dior', 'prada', 'versace', 'polo ralph lauren'];
const brandKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9.&' -]/g, '').replace(/\s+/g, ' ').trim();
export const isKnownBrand = (vendor) => { const k = brandKey(vendor); return !!k && KNOWN_BRANDS.some((b) => k === b || k.startsWith(`${b} `) || k.endsWith(` ${b}`) || k.includes(` ${b} `)); };
// Re-review N1: the brand a Shopify TITLE names — the title starts with a known brand, or carries one as a
// whole word (brands of ≥ 4 letters; "on" only counts at the start). → the brand, or null.
export const titleBrand = (title) => {
  const k = ` ${brandKey(title)} `;
  if (!k.trim()) return null;
  return [...KNOWN_BRANDS].sort((a, b) => b.length - a.length).find((b) => k.startsWith(` ${b} `) || (b.replace(/[^a-z]/g, '').length >= 4 && k.includes(` ${b} `))) || null;
};
// Our size → the category-map size group: men's = adult, W = women, Y = youth (GS), C ≤ 10 = toddler,
// C ≥ 10.5 = child (PS). null = not a US size we can read.
export function sizeGroupOf(size) {
  const p = parseSize(size);
  if (p.system !== 'US') return null;
  if (p.group === 'women') return 'women';
  if (p.group === 'youth') return p.n <= 3 ? 'child' : 'youth';   // 1Y–3Y are little kids (PS), not GS — review S6
  if (p.group === 'child') return p.n <= 10 ? 'toddler' : 'child';
  return p.group === 'adult' ? 'adult' : null;
}
export const boxGroupOf = (g) => (g === 'women' ? 'adult' : g);

// Validate a D6 box setting a person saves: four groups, cm strings (positive, ≤ 2 decimals), grams > 0.
// A shoe box is never over 30 in a side or 30 lb (2026-10-28: a toddler length typed as 166 in saved
// and would have gone to SHEIN). Checked on save AND on read, so a bad saved box blocks publishing.
export const BOX_MAX_IN = 30;
export const BOX_MAX_LB = 30;
const BOX_MAX_CM = BOX_MAX_IN * 2.54;
const BOX_MAX_G = Math.round(BOX_MAX_LB * 453.59237);
export function validateBoxDefaults(groups) {
  for (const g of Object.keys(BOX_PLACEHOLDERS)) {
    const x = groups?.[g];
    if (!x) return `Missing the ${g} box.`;
    for (const k of ['length', 'width', 'height']) {
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(String(x[k])) || !(Number(x[k]) > 0)) return `${g} ${k}: a positive number of cm, at most 2 decimals.`;
      if (Number(x[k]) > BOX_MAX_CM) return `${g} ${k}: ${Math.round(Number(x[k]) / 2.54 * 100) / 100} in is over ${BOX_MAX_IN} in — check for a typo.`;
    }
    if (!(Number(x.weight) > 0) || Math.round(Number(x.weight) * 100) !== Number(x.weight) * 100) return `${g} weight: grams, more than 0, at most 2 decimals.`;
    if (Number(x.weight) > BOX_MAX_G) return `${g} weight: ${Math.round(Number(x.weight) / 453.59237 * 100) / 100} lb is over ${BOX_MAX_LB} lb — check for a typo.`;
  }
  return null;
}

// The team measures boxes in inches and pounds (2026-10-27); SHEIN and the stored setting stay in cm
// and grams. The page shows and takes in/lb and converts on save — nothing server-side changes.
export const CM_PER_IN = 2.54;
export const G_PER_LB = 453.59237;
const round2 = (n) => Math.round(n * 100) / 100;
export const cmToIn = (cm) => round2(Number(cm) / CM_PER_IN);
export const gToLb = (g) => round2(Number(g) / G_PER_LB);
export const inToCm = (inch) => round2(Number(inch) * CM_PER_IN);
export const lbToG = (lb) => Math.round(Number(lb) * G_PER_LB);
export const boxToImperial = (groups) => Object.fromEntries(Object.entries(groups || {}).map(([g, x]) => [g, {
  length: String(cmToIn(x.length)), width: String(cmToIn(x.width)), height: String(cmToIn(x.height)), weight: String(gToLb(x.weight)),
}]));
export const boxFromImperial = (draft) => Object.fromEntries(Object.entries(draft || {}).map(([g, x]) => [g, {
  length: String(inToCm(x.length)), width: String(inToCm(x.width)), height: String(inToCm(x.height)), weight: lbToG(x.weight),
}]));
// A typed in/lb draft: positive numbers, at most 2 decimals, at most 30 in / 30 lb.
export function validateImperialBox(draft) {
  for (const g of Object.keys(BOX_PLACEHOLDERS)) {
    const x = draft?.[g];
    if (!x) return `Missing the ${g} box.`;
    for (const k of ['length', 'width', 'height', 'weight']) {
      const unit = k === 'weight' ? 'lb' : 'in';
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(String(x[k]).trim()) || !(Number(x[k]) > 0)) return `${g} ${k}: a positive number of ${k === 'weight' ? 'lb' : 'inches'}, at most 2 decimals.`;
      if (Number(x[k]) > (k === 'weight' ? BOX_MAX_LB : BOX_MAX_IN)) return `${g} ${k}: ${Number(x[k])} ${unit} is over ${k === 'weight' ? BOX_MAX_LB : BOX_MAX_IN} ${unit} — check for a typo.`;
    }
  }
  return validateBoxDefaults(boxFromImperial(draft));
}

// Shopify title → SHEIN name: trimmed, single spaces, no emoji.
export const cleanTitle = (t) => trim(String(t ?? '').replace(EMOJI_ALL, '').replace(/\s+/g, ' '));
// Bulk edit's "Tidy titles" (2026-10-28): the title SHEIN would get — cleanTitle, and when SHEIN's limit
// is known and it's over, cut at the last whole word that fits (no dangling punctuation). Nothing else
// is rewritten: a person reads the preview and applies it (it saves title_override, Shopify unchanged).
export function tidyTitle(title, max = null) {
  let t = cleanTitle(title);
  const m = Number(max) || 0;
  if (m > 1 && t.length > m) {
    const cut = t.slice(0, m + 1);
    const sp = cut.lastIndexOf(' ');
    t = (sp > m * 0.5 ? cut.slice(0, sp) : t.slice(0, m)).replace(/[\s,;:/(\-–—]+$/, '').trim();
  }
  return t;
}

// The categories the team uses most (2026-10-28, the user): shown on TOP of the category picker. Matched
// in SHEIN's own tree by the PATH's words (never a hard-coded id): the leaf name carries `leaf`, and the
// audience is read per word of every path segment — "Women" is not "men" (whole words, not substrings).
export const FAVOURITE_CATEGORIES = [
  { key: 'men_casual_athletic', label: 'Men’s Casual Athletic Shoes', who: 'men', leaf: ['casual', 'athletic'] },
  { key: 'women_casual_athletic', label: 'Women’s Casual Athletic Shoes', who: 'women', leaf: ['casual', 'athletic'] },
  { key: 'kids_sneakers', label: 'Kids’ Sneakers', who: 'kids', leaf: ['sneakers'] },
];
const AUDIENCE = {
  men: ['men', 'mens', 'man', 'male'],
  women: ['women', 'womens', 'woman', 'ladies', 'lady', 'female'],
  kids: ['kids', 'kid', 'children', 'childrens', 'child', 'boys', 'boy', 'girls', 'girl', 'baby', 'babies', 'toddler', 'toddlers', 'youth', 'teen', 'teens'],
};
const words = (seg) => String(seg || '').toLowerCase().replace(/[’'`]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const singular = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
// → [{ key, label, leaves:[leaf…] }] for the favourites found (≤ 2 leaves each, the closest first); a
// favourite SHEIN's tree doesn't have is left out.
export function favouriteLeaves(leaves = []) {
  const out = [];
  for (const f of FAVOURITE_CATEGORIES) {
    const hits = [];
    for (const l of leaves || []) {
      const segs = String(l?.path || '').split('›').map((x) => x.trim()).filter(Boolean);
      if (!segs.length) continue;
      const leafW = words(segs.at(-1)).map(singular);
      if (!f.leaf.every((w) => leafW.includes(singular(w)))) continue;
      const all = new Set(segs.flatMap(words));
      const has = (who) => AUDIENCE[who].some((w) => all.has(w));
      const ok = f.who === 'kids' ? has('kids') : f.who === 'women' ? has('women') && !has('kids') : has('men') && !has('women') && !has('kids');
      if (!ok) continue;
      const named = AUDIENCE[f.who].some((w) => words(segs.at(-1)).includes(w));   // "Men Casual Athletic Shoes" beats a deeper generic leaf
      hits.push({ l, score: (named ? 0 : 100) + segs.length });
    }
    hits.sort((a, b) => a.score - b.score || String(a.l.path).localeCompare(String(b.l.path)));
    if (hits.length) out.push({ key: f.key, label: f.label, leaves: hits.slice(0, 2).map((h) => h.l) });
  }
  return out;
}

// Shopify descriptionHtml → plain text (doc: "请不要输入html内容"): block tags → new lines, entities
// decoded, emoji / surrogates dropped, whitespace collapsed, cut to 5000 at a sentence / word boundary.
export function cleanDescription(html, max = 5000) {
  let t = String(html ?? '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '\n• ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(EMOJI_ALL, '');
  t = t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
    t = (at > max * 0.6 ? cut.slice(0, at + 1) : cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6))).trim();
  }
  return t;
}

// fill-in-standard picture_config_list → which photos go as which image type (spec §2.5). The NEW
// plan only when the list carries `spu_image_detail_show` (since 2026-10).
export function imagePlan(fill) {
  const flags = new Map((fill?.picture_config_list || []).map((x) => [x.field_key, x.is_true === true]));
  const sku = flags.get('sku_image_required') === true;
  if (!flags.has('spu_image_detail_show')) {
    return { newPlan: false, spu: [], skc: [{ type: 1, photo: 0 }, { type: 2, photo: 'details' }, { type: 5, photo: 0 }], sku, need: 2 };
  }
  const spu = [];
  if (flags.get('spu_image_detail_show')) { spu.push({ type: 1, photo: 0 }); if (!flags.get('spu_image_detail_single')) spu.push({ type: 2, photo: 'details' }); }
  if (flags.get('spu_image_square_required')) spu.push({ type: 5, photo: 0 });
  const skc = [{ type: 1, photo: 0 }];
  if (flags.get('skc_image_detail_required') && !flags.get('skc_image_detail_single')) skc.push({ type: 2, photo: 'details' });
  if (flags.get('skc_image_square_required')) skc.push({ type: 5, photo: 0 });
  const detailNeeded = [...spu, ...skc].some((x) => x.photo === 'details') && (flags.get('skc_image_detail_required') || flags.get('spu_image_detail_required'));
  return { newPlan: true, spu, skc, sku, need: detailNeeded ? 2 : 1 };
}
// The conversions a plan needs: [{ photo: index, type }], de-duplicated (one SHEIN URL per photo + type).
export function imageConversions(plan, photoCount) {
  const out = new Map();
  for (const x of [...plan.spu, ...plan.skc]) {
    const idx = x.photo === 'details' ? Array.from({ length: Math.max(0, Math.min(photoCount - 1, 10)) }, (_, i) => i + 1) : [x.photo];
    for (const i of idx) if (i < photoCount) out.set(`${i}:${x.type}`, { photo: i, type: x.type });
  }
  return [...out.values()];
}
// converted: Map(`${photo}:${type}` → SHEIN url) → image_info_list (sort 1..n: main, details, square).
function imageList(group, converted, photoCount) {
  const list = [];
  for (const x of group) {
    const idx = x.photo === 'details' ? Array.from({ length: Math.max(0, Math.min(photoCount - 1, 10)) }, (_, i) => i + 1) : [x.photo];
    for (const i of idx) { const url = converted.get(`${i}:${x.type}`); if (url) list.push({ image_type: x.type, image_url: url }); }
  }
  list.sort((a, b) => ({ 1: 0, 2: 1, 5: 2 }[a.image_type] ?? 3) - ({ 1: 0, 2: 1, 5: 2 }[b.image_type] ?? 3));
  return list.map((x, i) => ({ image_sort: i + 1, image_type: x.image_type, image_url: x.image_url }));
}

// The template for one product type → its parts (spec §2.4, §3.1).
export function templateParts(template) {
  const attrs = template?.attribute_infos || [];
  const main = attrs.find((a) => Number(a.attribute_type) === 1 && Number(a.attribute_label) === 1) || null;
  const size = template ? templateSizes([template], template.product_type_id) : null;
  const product = attrs.filter((a) => [3, 4].includes(Number(a.attribute_type)) && Number(a.attribute_status) !== 1);
  const sizeTable = attrs.filter((a) => Number(a.attribute_type) === 2);
  return { main, size, product, sizeTable, mainStatus: Number(template?.main_attribute_status) || 2 };
}
const valueLabel = (v) => trim(v?.attribute_value_en || v?.attribute_value);
const isDefault = (v) => /^(default|默认)$/i.test(valueLabel(v));

// A product type's attribute rows from the person's defaults (never automatic). required = status 3 ∪
// the associated rules' ids (`assoc`: [{attribute_id, allowed:[ids]}]). → { rows, problems }.
export function buildAttributes({ parts, defaults = [], assoc = [] }) {
  const rows = []; const problems = [];
  const byId = new Map(defaults.map((d) => [Number(d.attribute_id), d]));
  const assocBy = new Map((assoc || []).map((a) => [Number(a.attribute_id), a]));
  const tableIds = new Set(parts.sizeTable.map((a) => Number(a.attribute_id)));
  for (const id of assocBy.keys()) if (tableIds.has(id)) problems.push(blocker('size_table_not_yet', { attributeId: id, why: 'assoc_rule' }));
  for (const a of parts.product) {
    const id = Number(a.attribute_id); const name = a.attribute_name_en || a.attribute_name || String(id);
    const required = Number(a.attribute_status) === 3 || assocBy.has(id);
    const d = byId.get(id);
    const known = new Set((a.attribute_value_info_list || []).map((v) => Number(v.attribute_value_id)));
    const allowed = assocBy.get(id)?.allowed || [];
    if (Number(a.data_dimension) === 3) { if (required) problems.push(blocker('missing_attr', { attributeId: id, attribute: name, why: 'sku_scope' })); continue; }
    if (!d) { if (required) problems.push(blocker('missing_attr', { attributeId: id, attribute: name, allowed: allowed.length ? allowed : [...known].slice(0, 30) })); continue; }
    if (d.stale) { problems.push(blocker('missing_attr', { attributeId: id, attribute: name, why: 'template_changed' })); continue; }
    const ids = (d.value_ids || []).map(Number); const extras = (d.extra_values || []).map(String);
    const mode = Number(a.attribute_mode);
    if (ids.some((v) => !known.has(v))) { problems.push(blocker('missing_attr', { attributeId: id, attribute: name, why: 'value_not_in_template' })); continue; }
    if (allowed.length && ids.some((v) => !allowed.includes(v))) { problems.push(blocker('missing_attr', { attributeId: id, attribute: name, why: 'value_not_allowed', allowed })); continue; }
    if (mode === 3) {
      if (ids.length !== 1) { problems.push(blocker('missing_attr', { attributeId: id, attribute: name, why: 'one_value' })); continue; }
      rows.push({ attribute_id: id, attribute_value_id: ids[0] });
    } else if (mode === 1) {
      const max = Number(a.attribute_input_num) || 0;
      if (!ids.length || (max && ids.length > max)) { problems.push(blocker('missing_attr', { attributeId: id, attribute: name, why: 'value_count', max })); continue; }
      for (const v of ids) rows.push({ attribute_id: id, attribute_value_id: v });
    } else if (mode === 0) {
      const t = extras[0];
      const intOnly = (a.rule_info_list || []).some((r) => Number(r.condition_type) === 1);
      if (!t || (intOnly && !/^[1-9]\d*$/.test(t))) { problems.push(blocker('missing_attr', { attributeId: id, attribute: name, why: 'typed_value' })); continue; }
      rows.push({ attribute_id: id, attribute_extra_value: t });
    } else if (mode === 4) {
      if (!ids.length || ids.length !== extras.length) { problems.push(blocker('missing_attr', { attributeId: id, attribute: name, why: 'value_and_amount' })); continue; }
      if (Number(a.attribute_type) === 3 && extras.reduce((n, x) => n + Number(x), 0) !== 100) { problems.push(blocker('missing_attr', { attributeId: id, attribute: name, why: 'sum_100' })); continue; }
      ids.forEach((v, i) => rows.push({ attribute_id: id, attribute_value_id: v, attribute_extra_value: extras[i] }));
    }
  }
  // An assoc-rule attribute that isn't a product attribute of the template at all
  for (const id of assocBy.keys()) if (!parts.product.some((a) => Number(a.attribute_id) === id) && !tableIds.has(id) && !byId.has(id)) problems.push(blocker('missing_attr', { attributeId: id, why: 'assoc_rule' }));
  return { rows, problems };
}

// fill-in-standard field_keys → what we do (spec §3.2). → { problems, send: { shelfRequire, skcTitle } }
const HANDLED_KEYS = new Set(['brand_code', 'supplier_code', 'mall_state', 'skc_title', 'shelf_require', 'stop_purchase']);
export function fillRules(fill) {
  const problems = []; const send = { shelfRequire: false, skcTitle: false };
  for (const f of fill?.fill_in_standard_list || []) {
    if (f.field_key === 'shelf_require' && f.required === true) send.shelfRequire = true;
    else if (f.field_key === 'skc_title' && f.required === true) send.skcTitle = true;
    else if (f.required === true && !HANDLED_KEYS.has(f.field_key)) problems.push(blocker('fill_required', { field: f.field_key }));
  }
  // weight_config / length_width_height_config (in the example, not the field table): look for unit
  // strings anywhere. g / cm (or 1) listed → fine; units listed but none of ours → blocked; no unit we
  // can read → a note to check (review S2).
  const notes = [];
  for (const [cfg, ours] of [[fill?.weight_config, /^(g|gram|grams|1)$/i], [fill?.length_width_height_config, /^(cm|1)$/i]]) {
    if (cfg == null) continue;
    const units = [...JSON.stringify(cfg).matchAll(/"([a-zA-Z]{1,6}|1)"/g)].map((m) => m[1]).filter((u) => /^(g|gram|grams|kg|lb|lbs|oz|cm|mm|m|in|inch|1)$/i.test(u));
    if (!units.length) notes.push(blocker('unit_unverified', {}));
    else if (!units.some((u) => ours.test(u))) problems.push(blocker('no_weight', { why: 'unit', units }));
  }
  return { problems, send, notes };
}

/* --------------------------------- the plan --------------------------------- */

const LINES = [
  [1, 'store', 'SHEIN can take new listings', ['store_cannot_publish']],
  [2, 'quota', 'Publish quota', ['publish_quota_used']],
  [3, 'shelf', 'Shelf quota', ['shelf_quota_full']],
  [4, 'site', 'Selling on shein-us', ['store_cannot_publish:no_us_site', 'no_warehouse']],
  [5, 'shopify', 'Active on Shopify, with stock', ['shopify_inactive', 'no_shopify_stock']],
  [6, 'category', 'Category picked', ['no_category', 'mixed_size_groups']],
  [7, 'brand', 'Brand', ['brand_not_authorized', 'brand_unset', 'brand_none', 'brand_list_unread']],
  [8, 'title', 'Title', ['title_too_long', 'language_not_en']],
  [9, 'colour', 'Colour (SKC value)', ['missing_attr:skc_colour', 'missing_attr:no_default_value']],
  [10, 'attributes', 'SHEIN details', ['missing_attr']],
  [11, 'size_chart', 'Size chart', ['size_table_not_yet', 'no_size_table_value']],
  [12, 'sizes', 'Sizes', ['size_needs_map', 'size_not_on_shein', 'custom_unconfirmed', 'size_unchecked', 'custom_text_invalid', 'size_unreadable', 'size_already_on_shein', 'nothing_to_add']],
  [13, 'skus', 'Seller SKUs', ['no_seller_sku', 'dup_seller_sku', 'seller_sku_taken']],
  [14, 'prices', 'Prices', ['no_price']],
  [15, 'box', 'Box size / weight', ['no_weight', 'box_unconfirmed', 'unit_unverified']],
  [16, 'photos', 'Photos', ['no_image', 'image_rejected', 'photos_need_priv', 'photo_cap_reached']],
  [17, 'fields', 'SHEIN extra fields', ['fill_required']],
  [18, 'flight', 'Not already sent / in review', ['publish_in_flight', 'publish_rejected', 'publish_unconfirmed']],
];
const lineOf = (b) => {
  const k = `${b.code}:${b.params?.why || ''}`;
  for (const [n, , , codes] of LINES) if (codes.includes(k)) return n;
  for (const [n, , , codes] of LINES) if (codes.includes(b.code)) return n;
  return 17;
};
// The checklist: { n, key, label, ok: true | false | null (not checked yet), blockers: [rendered] }.
export function publishChecklist(blockers = [], { unknown = [] } = {}) {
  const by = new Map();
  for (const b of blockers) { const n = lineOf(b); const a = by.get(n) || []; a.push(b); by.set(n, a); }
  return LINES.map(([n, key, label]) => {
    const bs = (by.get(n) || []);
    const hard = bs.filter(isBlocking);
    return { n, key, label, ok: hard.length ? false : unknown.includes(key) ? null : true, blockers: bs.map((b) => ({ ...renderBlocker(b), params: b.params })) };
  });
}

// The whole plan for ONE Shopify product → { body | null, plan, checklist }. See the server for inputs.
export function planPublish(input) {
  const {
    product, productRow = {}, gates = {}, category = null, fill = null, template = null, assoc = [], attrDefaults = [], brand = null,
    maps = [], permission = null, customValues = [], market = new Map(), box = null, images = null, taken = new Set(), inFlight = false,
    unconfirmed = null, rejected = null, skuCounts = new Map(), unknown = [], readiness = false,
  } = input;
  const blockers = []; const notes = [];
  let brandUnread = false;   // N2: SHEIN's brand list wasn't read — the Brand line is "not read yet" and nothing is sendable
  const plan = { op: 'publish', productId: product?.productId || null, sizes: [], skipped: [], images: [], attributes: [], blockers, notes };
  // A line not read from SHEIN yet is null ("not read yet") — never ✓ by default (review).
  const unknownLines = () => {
    const u = new Set(unknown);
    if (!gates.perm) u.add('store'); if (!gates.quota) u.add('quota'); if (!gates.shelf) u.add('shelf'); if (gates.site === undefined || gates.warehouse === undefined) u.add('site');
    if (!fill) { u.add('brand'); u.add('title'); u.add('fields'); }
    if (!template) { u.add('colour'); u.add('attributes'); u.add('size_chart'); u.add('sizes'); u.add('prices'); }
    if (!images) u.add('photos');
    if (brandUnread) u.add('brand');
    if (input.takenChecked !== true) u.add('skus');
    return [...u];
  };
  const done = (body = null) => ({ body: blockers.some(isBlocking) || !plan.sizes.length || brandUnread ? null : body, plan, checklist: publishChecklist([...blockers, ...notes], { unknown: unknownLines() }) });
  if (!product) { blockers.push(blocker('shopify_inactive', { status: 'DELETED' })); return done(); }

  // 1A · store gates (spec G1–G5)
  if (gates.perm && gates.perm.canPublishProduct !== true) blockers.push(blocker('store_cannot_publish', { sheinMessage: gates.perm.reason || null }));
  const need = Math.max(1, Number(gates.need) || 1);
  // S7: a brand may be quota-exempt — the brand's own quota answer wins when it is better
  const bq = input.brandQuota || null;
  const quotaOk = (q) => q && (q.isControlled === false || Number(q.availableQuota) >= need);
  if (gates.quota && gates.quota.isControlled === true && !(Number(gates.quota.availableQuota) >= need) && !quotaOk(bq)) blockers.push(blocker('publish_quota_used', { available: gates.quota.availableQuota ?? 0, need }));
  if (gates.shelf && gates.shelf.need === true && !(Number(gates.shelf.remain_count) >= need)) blockers.push(blocker('shelf_quota_full', { remain: gates.shelf.remain_count ?? 0 }));
  if (gates.site === null) blockers.push(blocker('store_cannot_publish', { why: 'no_us_site', reason: 'shein-us isn’t an enabled USD site for the store' }));
  if (gates.warehouse === null) blockers.push(blocker('no_warehouse'));
  plan.quota = gates.quota ? (quotaOk(bq) && bq.isControlled === false ? { controlled: false, available: null, uses: need, brandExempt: true }
    : { controlled: gates.quota.isControlled === true, available: gates.quota.availableQuota ?? null, uses: need }) : null;
  if (inFlight) blockers.push(blocker('publish_in_flight'));
  // re-review G1: an earlier publish of this product SHEIN never confirmed → nothing new until it is resolved
  if (unconfirmed) blockers.push(blocker('publish_unconfirmed', { itemId: unconfirmed.itemId ?? null, jobId: unconfirmed.jobId ?? null, other: true }));
  if (rejected) blockers.push(blocker('publish_rejected', { failedReason: rejected.failedReason || null }));

  // 1B-1 · Shopify
  if (String(product.status || '').toUpperCase() !== 'ACTIVE') blockers.push(blocker('shopify_inactive', { status: product.status || null }));
  // the listing syncs' gate (2026-10-28): an active shoe with 0 pairs on Shopify isn't published
  else if (listingSyncGate(product, productRow.excludedVariants || new Set())) blockers.push(blocker('no_shopify_stock', {}));
  const variants = (product.variants || []).filter((v) => !(productRow.excludedVariants || new Set()).has(v.variantId));
  const groups = [...new Set(variants.map((v) => sizeGroupOf(v.size)).filter(Boolean))];
  plan.sizeGroup = groups.length === 1 ? groups[0] : null;
  if (groups.length > 1) blockers.push(blocker('mixed_size_groups', { groups }));

  // 1B-2 · category (D7)
  if (!category) blockers.push(blocker('no_category', { suggestion: input.suggestion || null }));
  else if (category.treeOk === false) blockers.push(blocker('no_category', { why: 'tree_changed', categoryId: category.categoryId }));
  plan.category = category ? { id: category.categoryId, productTypeId: category.productTypeId, path: category.path || null } : null;

  // 1B-3 · rules
  if (category && !fill && !readiness) blockers.push(blocker('fill_required', { field: 'query-publish-fill-in-standard (not read)' }));
  const fr = fillRules(fill); blockers.push(...fr.problems); notes.push(...(fr.notes || []));
  const lang = fill?.default_language || 'en';
  // re-review N3: we only write English — a store whose SHEIN default language isn't en is blocked
  if (fill && String(lang).toLowerCase() !== 'en') blockers.push(blocker('language_not_en', { language: String(lang) }));

  // title (§2.3) — a person may shorten it for SHEIN (title_override)
  const title = cleanTitle(productRow.title_override || product.title);
  const max = Number(fill?.default_language_title_max_length) || 1000;
  if (title.length < 2) blockers.push(blocker('title_too_long', { why: 'too_short', length: title.length }));
  else if (title.length > max) blockers.push(blocker('title_too_long', { length: title.length, max }));
  plan.title = { text: title, max, overridden: !!productRow.title_override };
  // S9: the SKC title (when SHEIN requires one) has its own per-language limit
  if (fr.send.skcTitle) {
    const skcMax = Number((fill?.language_title_max_length_list || []).find((x) => x.language === lang)?.max_length) || max;
    if (title.length > skcMax) blockers.push(blocker('title_too_long', { length: title.length, max: skcMax, why: 'skc_title' }));
  }
  const desc = cleanDescription(product.descriptionHtml || '');
  plan.description = { length: desc.length };

  // brand (D5)
  // D5 (review F2): a brand only from SHEIN's list for our store. No map → BLOCKED, unless a person
  // marked this vendor "no brand" (never allowed for a known brand). A brand SHEIN's rules hide
  // (brand_code show:false) also blocks — we never leave a known brand out silently.
  const brandRule = (fill?.fill_in_standard_list || []).find((f) => f.field_key === 'brand_code') || null;
  const brandReq = brandRule?.required === true;
  let brandCode = null;
  if (fill) {
    if (brand?.code) {
      if (brand.listed == null) { brandUnread = true; if (!readiness) notes.push(blocker('brand_list_unread', { brand: product.vendor || null })); }
      else if (!brand.listed) blockers.push(blocker('brand_not_authorized', { brand: product.vendor || null }));
      else if (brandRule?.show === false) blockers.push(blocker('brand_not_authorized', { brand: product.vendor || null, why: 'hidden_by_rules' }));
      else brandCode = brand.code;
    } else if (brand?.noBrand && !isKnownBrand(product.vendor) && !titleBrand(product.title)) {
      if (brandReq) blockers.push(blocker('brand_not_authorized', { brand: product.vendor || null, why: 'required' }));
      else notes.push(blocker('brand_none', { brand: product.vendor || null }));
    } else {
      const tb = isKnownBrand(product.vendor) ? null : titleBrand(product.title);
      blockers.push(blocker('brand_unset', { brand: product.vendor || null, known: isKnownBrand(product.vendor) || !!tb, ...(tb ? { titleBrand: tb, why: brand?.noBrand ? 'title_brand' : undefined } : {}) }));
    }
  }
  plan.brand = brandCode ? { code: brandCode, name: brand?.name || null } : null;

  // template: main (SKC) value, product attributes, size field, size chart
  const parts = templateParts(template);
  let skcValue = null;
  if (category && template) {
    if (!parts.main) blockers.push(blocker('missing_attr', { why: 'no_main_attribute' }));
    else {
      const vals = parts.main.attribute_value_info_list || [];
      const def = vals.find(isDefault);
      const chosen = productRow.skc_value_id ? vals.find((v) => Number(v.attribute_value_id) === Number(productRow.skc_value_id)) : null;
      if (parts.mainStatus === 1) { if (def) skcValue = def; else blockers.push(blocker('missing_attr', { attributeId: parts.main.attribute_id, why: 'no_default_value' })); }
      else if (parts.mainStatus === 3) { if (chosen && !isDefault(chosen)) skcValue = chosen; else blockers.push(blocker('missing_attr', { attributeId: parts.main.attribute_id, attribute: parts.main.attribute_name_en || 'Colour', why: 'skc_colour' })); }
      else { skcValue = chosen || def || null; if (!skcValue) blockers.push(blocker('missing_attr', { attributeId: parts.main.attribute_id, attribute: parts.main.attribute_name_en || 'Colour', why: 'skc_colour' })); }
    }
    if (parts.sizeTable.some((a) => Number(a.attribute_status) === 3)) blockers.push(blocker('size_table_not_yet'));
    const at = buildAttributes({ parts, defaults: attrDefaults, assoc });
    blockers.push(...at.problems);
    plan.attributes = at.rows;
    if (!parts.size) blockers.push(blocker('size_unchecked', { reason: 'no_size_attribute' }));
  } else if (category && !template && !readiness) blockers.push(blocker('missing_attr', { why: 'template_unread' }));
  plan.skcValue = skcValue ? { id: Number(skcValue.attribute_value_id), label: valueLabel(skcValue) } : null;

  // sizes (§2.4) — Phase 2's resolver; zero-stock sizes go at stock 0 (D10)
  const sizeAttr = parts.size?.attributeId ?? null;
  plan.sizeAttributeId = sizeAttr;
  const ctx = { categoryId: category?.categoryId, attributeId: sizeAttr, values: parts.size?.values || null, permission, sizeTable: false, customValues, maps };
  const used = new Set();
  for (const v of variants) {
    const sku = trim(v.sku);
    const skip = (b) => plan.skipped.push({ variantId: v.variantId, size: v.size, sku, blocker: b });
    if (!sku) { blockers.push(blocker('no_seller_sku', { size: v.size }, 'sku')); continue; }
    if ((skuCounts.get(sku) || 0) > 1) { blockers.push(blocker('dup_seller_sku', { sku, count: skuCounts.get(sku) }, 'sku')); continue; }
    if (taken.has(sku)) { blockers.push(blocker('seller_sku_taken', { sku }, 'sku')); continue; }
    if (!sizeAttr) continue;
    const res = resolveSize(v.size, ctx);
    if (res.blocker) { skip(res.blocker); continue; }
    if (!res.kind) { skip(res.note || blocker('size_unchecked', { size: v.size })); continue; }
    if (res.kind === 'custom') {
      if (permission !== 1) { skip(blocker('size_not_on_shein', { size: v.size, categoryId: category?.categoryId })); continue; }
      const bad = validateCustomText(res.label) || customTextConflict(res.label, { values: parts.size?.values || [], customValues });
      if (bad) { skip(blocker('custom_text_invalid', { size: v.size, text: res.label, why: bad })); continue; }
      if (!res.map?.set_by || !['person', 'custom_created'].includes(res.map.source)) { skip(blocker('custom_unconfirmed', { size: v.size, text: res.label })); continue; }
    }
    const key = res.kind === 'value' ? `id:${res.valueId}` : `t:${String(res.label).toLowerCase()}`;
    if (used.has(key)) { skip(blocker('size_already_on_shein', { size: v.size, sheinSize: res.label })); continue; }
    const price = sheinNewSizePrice({ marketCents: market.get(v.variantId) ?? null, shopifyPrice: v.price });
    if (!price) { blockers.push(blocker('no_price', { size: v.size }, 'price')); continue; }
    used.add(key);
    plan.sizes.push({ variantId: v.variantId, size: v.size, sku, sheinSize: res.label, kind: res.kind, valueId: res.valueId ?? null, source: res.source, mapId: res.map?.id ?? null,
      sizeKey: res.key, price: price.price, priceFrom: price.from, qty: v.qty ?? null });
  }
  const inStockSkipped = plan.skipped.filter((x) => Number(variants.find((v) => v.variantId === x.variantId)?.qty) > 0);
  for (const x of inStockSkipped) blockers.push({ ...x.blocker, params: { ...(x.blocker.params || {}), size: x.size } });
  if (sizeAttr && !plan.sizes.length) blockers.push(blocker('nothing_to_add'));
  plan.sizes.sort((a, b) => sizeSort(a.size) - sizeSort(b.size));

  // box size / weight (D6) — a person must have confirmed the defaults
  const bg = plan.sizeGroup ? boxGroupOf(plan.sizeGroup) : null;
  const bx = bg ? box?.groups?.[bg] : null;
  if (!box?.confirmed) blockers.push(blocker('box_unconfirmed'));
  else if (!bx) blockers.push(blocker('no_weight', { group: bg }));
  plan.box = bx ? { group: bg, ...bx, confirmed: !!box?.confirmed } : null;

  // images (§2.5) — converted by the server; refusals / too few photos block
  const ip = imagePlan(fill);
  plan.imagePlan = { newPlan: ip.newPlan, need: ip.need, sku: ip.sku };
  if (readiness && product.imageCount != null && Number(product.imageCount) < ip.need) blockers.push(blocker('no_image', { count: Number(product.imageCount), need: ip.need }));
  if (images) {
    for (const e of images.errors || []) blockers.push(blocker('image_rejected', { reason: e.reason, sheinMessage: e.sheinMessage || null, photo: e.photo + 1 }));
    if ((images.photoCount || 0) < ip.need) blockers.push(blocker('no_image', { count: images.photoCount || 0, need: ip.need }));
    if (images.capReached) blockers.push(blocker('photo_cap_reached', { cap: images.capReached.cap, used: images.capReached.used }));
  }

  // the body (§2) — only when nothing blocks
  if (blockers.some(isBlocking) || !plan.sizes.length || !images || !category || !template) return done();
  const conv = new Map(Object.entries(images.converted || {}));
  const supplierCode = `SB12-P${String(product.productId).split('/').pop()}`;
  const site = gates.site?.main_site || 'shein';
  const skcImages = imageList(ip.skc, conv, images.photoCount);
  const mainUrl = skcImages.find((x) => x.image_type === 1)?.image_url || null;
  const sku = (z) => ({
    sale_attribute_list: [z.kind === 'value' ? { attribute_id: Number(sizeAttr), attribute_value_id: Number(z.valueId) } : { attribute_id: Number(sizeAttr), custom_attribute_value: z.sheinSize, language: 'en' }],
    supplier_sku: z.sku, mall_state: 1,
    length: String(bx.length), width: String(bx.width), height: String(bx.height), weight: Number(bx.weight),
    price_info_list: [{ base_price: z.price, currency: 'USD', sub_site: 'shein-us' }],
    stock_info_list: [{ inventory_num: 0, ...(gates.warehouse?.code ? { supplier_warehouse_id: gates.warehouse.code } : {}) }],
    ...(ip.sku && mainUrl ? { image_info: { image_info_list: [{ image_sort: 1, image_type: 1, image_url: mainUrl }] } } : {}),
  });
  const body = {
    category_id: Number(category.categoryId), product_type_id: Number(category.productTypeId), source_system: 'OpenAPI', suit_flag: '0', is_spu_pic: ip.newPlan,
    ...(brandCode ? { brand_code: brandCode } : {}),
    ...(fill?.supplier_code_in_spu_dimension === true ? { supplier_code: supplierCode } : {}),
    multi_language_name_list: [{ language: lang, name: title }],
    ...(desc.length >= 2 ? { multi_language_desc_list: [{ language: lang, name: desc }] } : {}),
    site_list: [{ main_site: site, sub_site_list: ['shein-us'] }],
    product_attribute_list: plan.attributes,
    ...(ip.newPlan && imageList(ip.spu, conv, images.photoCount).length ? { image_info: { image_info_list: imageList(ip.spu, conv, images.photoCount) } } : {}),   // S1: never an empty list
    skc_list: [{
      supplier_code: supplierCode,
      sale_attribute: { attribute_id: Number(parts.main.attribute_id), attribute_value_id: Number(skcValue.attribute_value_id) },
      ...(fr.send.shelfRequire ? { shelf_require: '0' } : {}),
      ...(fr.send.skcTitle ? { skc_multi_language_name_list: [{ language: lang, name: title }] } : {}),
      image_info: { image_info_list: skcImages },
      sku_list: plan.sizes.map(sku),
    }],
  };
  if (fill?.support_sale_attribute_sort === true) {
    body.sale_attribute_sort_list = [{ attribute_id: Number(sizeAttr), in_order_attribute_value_list: plan.sizes.map((z) => (z.kind === 'value' ? { attribute_value_id: String(z.valueId) } : { custom_attribute_value: z.sheinSize })) }];
  }
  plan.supplierCode = supplierCode;
  plan.images = skcImages;
  return done(body);
}

// One line for a person (the dry-run sheet / job list) — the shared summarizePlan handles op 'publish'.
export { summarizePlan as summarizePublish } from './sheinListings.js';

// The readiness (a snapshot / a Shopify webhook — NO SHEIN call): the publish plan from what is cached,
// for a product not on SHEIN. → { productBlockers, sizeFor: Map(variantId → resolveSize-like) }.
// Size / SKU / price problems stay with their variant; the rest is the product's.
const VARIANT_CODES = new Set(['size_needs_map', 'size_not_on_shein', 'size_unreadable', 'custom_text_invalid', 'custom_unconfirmed', 'size_unchecked', 'size_already_on_shein',
  'no_price', 'no_seller_sku', 'dup_seller_sku', 'seller_sku_taken', 'nothing_to_add']);
export function publishReadiness(product, ctx = {}) {
  const groups = [...new Set((product.variants || []).map((v) => sizeGroupOf(v.size)).filter(Boolean))];
  const row = groups.length === 1 ? (ctx.categoryMaps || []).find((m) => m.shopify_product_type === String(product.productType || '') && m.size_group === groups[0]) : null;
  const category = row ? { categoryId: Number(row.category_id), productTypeId: Number(row.product_type_id), path: row.category_path || null } : null;
  const fill = category ? ctx.fills?.get(category.categoryId) || null : null;
  const template = category ? ctx.templates?.get(category.productTypeId) || null : null;
  const parts = template ? templateParts(template) : null;
  const bm = (ctx.brandMaps || []).find((b) => b.vendor === String(product.vendor || '').trim().toLowerCase());
  const perm = category && parts?.size ? ctx.permissions?.get(`${category.categoryId}|${parts.size.attributeId}`) : null;
  const { plan, checklist } = planPublish({
    product, productRow: { ...(ctx.productRow || {}), excludedVariants: ctx.excludedVariants || new Set() }, category, fill, template, attrDefaults: (ctx.attrDefaults || []).filter((d) => category && Number(d.product_type_id) === category.productTypeId),
    brand: bm ? { code: bm.brand_code, name: bm.brand_name, noBrand: !!bm.no_brand, listed: !bm.brand_code ? true : !ctx.brands ? null : ctx.brands.some((b) => b.brand_code === bm.brand_code) } : null,
    unconfirmed: ctx.unconfirmed?.get?.(product.productId) || null,
    maps: ctx.maps || [], permission: perm == null ? null : Number(perm), customValues: (parts?.size?.values || []).filter((v) => v.custom).map((v) => v.label),
    market: ctx.market || new Map(), box: ctx.box || null, images: null, readiness: true,
  });
  const sizeFor = new Map();
  for (const z of plan.sizes) sizeFor.set(z.variantId, { key: z.sizeKey, kind: z.kind, valueId: z.valueId, label: z.sheinSize, source: z.source, blocker: null, note: z.kind === 'custom' ? blocker('custom_size', { size: z.size, text: z.sheinSize }) : null });
  for (const x of plan.skipped) {
    const level = BLOCKERS[x.blocker?.code]?.level;
    sizeFor.set(x.variantId, { key: null, kind: null, valueId: null, label: null, source: null, blocker: ['note', 'review'].includes(level) ? null : x.blocker, note: ['note', 'review'].includes(level) ? x.blocker : null });
  }
  const seen = new Set();
  // no_shopify_stock stays on the checklist (line 5) but NOT on the stored sizes: a sold-out shoe isn't "Blocked" on the list
  const productBlockers = [...plan.blockers, ...plan.notes].filter((b) => b.code !== 'no_shopify_stock' && !VARIANT_CODES.has(b.code) && !seen.has(`${b.code}:${b.params?.why || ''}`) && seen.add(`${b.code}:${b.params?.why || ''}`));
  return { productBlockers, sizeFor, category, checklist, titleMax: plan.title?.max ?? null, titleMaxRead: !!(ctx.fills && category && ctx.fills.get(category.categoryId)), sizeGroup: plan.sizeGroup ?? null };
}

