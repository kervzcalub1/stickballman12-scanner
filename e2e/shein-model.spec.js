// SHEIN Product Model from the shoe's TITLE (owner, 2026-11-14) — the pure side. No server, no SHEIN, no DB.
// What this pins:
//   · modelFromTitle matches all 50 models a person typed by hand (e2e/fixtures/shein-models.tsv: title \t brand \t
//     model \t valueIds — the shoes' attr_overrides on 2026-11-11), EXACTLY and `sure`;
//   · the edge rules: style codes, Wmns / Women's, a collab prefix, '07 / Big Bubble / GS / year dropped, Air Flight '89,
//     Ultraboost, AF1 Flyknit 2.0, numbered vs non-numbered Jordan, a quoted colourway, New Balance numbers; an
//     unknown model is a GUESS (`sure: false`), never sure;
//   · shoeAttrDefaults: the shoe's typed model wins → else the title when sure (shoe: true, from: 'title') → else
//     nothing (blocked "type it for this shoe"); only for 1000546 and only when the template lists it;
//   · a Setup row for a TYPED detail (the "Dunk Low" / "ACG Air Max" leak) never reaches a publish or an edit;
//   · two shoes of the same product type get their own models; setupModelCorrections (the read-only report).
// The DB / fake-SHEIN half (preview bodies, the Setup refusal, the per-shoe save, editAttrs, the report query) is in
// e2e/shein-listings.spec.js → "Product Model from the title".
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelFromTitle, shoeModel, setupModelCorrections, PRODUCT_MODEL_ATTR_ID } from '../src/lib/sheinModel.js';
import { shoeAttrDefaults, buildAttributes, attributePatch, templateParts, typedAttrIds, modelOf, planModelFix, currentAttrRows } from '../src/lib/sheinPublish.js';
import { summarizePlan } from '../src/lib/sheinListings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TYPED = fs.readFileSync(path.join(here, 'fixtures', 'shein-models.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t'));

const PT = 5512;
const MODEL = { attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_name_en: 'Product Model', attribute_type: 4, attribute_mode: 0, attribute_status: 3, data_dimension: 2, attribute_value_info_list: [] };
const SERIES = { attribute_id: 1002319, attribute_name_en: 'Series', attribute_type: 4, attribute_mode: 0, attribute_status: 2, data_dimension: 2, attribute_value_info_list: [] };
const UPPER = { attribute_id: 7000, attribute_name_en: 'Upper Material', attribute_type: 3, attribute_mode: 3, attribute_status: 3, data_dimension: 1,
  attribute_value_info_list: [{ attribute_value_id: 7001, attribute_value_en: 'Leather' }, { attribute_value_id: 7002, attribute_value_en: 'Mesh' }] };
const TEMPLATE = { product_type_id: PT, main_attribute_status: 2, attribute_infos: [UPPER, MODEL, SERIES] };
const NO_MODEL = { product_type_id: PT, main_attribute_status: 2, attribute_infos: [UPPER] };
// Setup: a picked default (fine) + the leak: typed defaults for the whole type
const SETUP = [
  { product_type_id: PT, attribute_id: 7000, value_ids: [7001], extra_values: [] },
  { product_type_id: PT, attribute_id: PRODUCT_MODEL_ATTR_ID, value_ids: [], extra_values: ['ACG Air Max'] },
  { product_type_id: PT, attribute_id: 1002319, value_ids: [], extra_values: ['Air Max'] },
];
const own = (model, ptid = PT) => ({ [PRODUCT_MODEL_ATTR_ID]: { ptid, valueIds: [], extraValues: [model], by: 'E2E PH', at: '2026-11-14T15:00:00Z' } });
const cur = (id, valueId, value) => ({ attributeId: id, attributeValueId: valueId, ...(value ? { attributeValue: value } : {}) });

test.describe('SHEIN Product Model from the title (pure)', () => {
  test('matches all 50 models a person typed by hand — exactly, and sure', () => {
    expect(TYPED.length).toBe(50);
    const misses = TYPED.map(([title, , want]) => ({ title, want, got: modelFromTitle(title) })).filter((x) => x.got.model !== x.want || !x.got.sure);
    expect(misses).toEqual([]);
  });

  test('the rules: codes, gender, collabs, dropped words, Jordans, quotes, New Balance; an unknown model is only a guess', () => {
    const m = (t) => modelFromTitle(t);
    expect(m("Nike Air Force 1 Low '07 LV8 Hydrangeas Patent (HV9405-500)")).toEqual({ model: 'Air Force 1 Low LV8', sure: true });
    expect(m('Nike Air Max 95 OG Big Bubble Neon 2025/2026 (HM4740-001)')).toEqual({ model: 'Air Max 95 OG', sure: true });
    expect(m("Nike Air Flight '89 True Blue 2020 (CN5668-101)")).toEqual({ model: 'Air Flight 89', sure: true });
    expect(m('adidas Ultra Boost 1.0 DNA Grey (HQ4200)')).toEqual({ model: 'Ultraboost 1.0', sure: true });
    expect(m('Nike Air Force 1 Flyknit 2 Black Pure Platinum (AV3042-001)')).toEqual({ model: 'Air Force 1 Flyknit 2.0', sure: true });
    expect(m('Jordan 6 Retro Infrared White 2026 GS (384665-105)')).toEqual({ model: 'Air Jordan 6 Retro', sure: true });
    expect(m('Jordan 6 Rings Anthracite (322992-026)')).toEqual({ model: 'Jordan 6 Rings', sure: true });
    expect(m('Jordan Stay Loyal Triple Black (DB2884-002)')).toEqual({ model: 'Jordan Stay Loyal', sure: true });
    expect(m("Air Jordan Wmns 1 Retro High OG 'Khaki' (FD2596-201)")).toEqual({ model: 'Air Jordan 1 Retro High OG', sure: true });
    expect(m("Nike Wmns Vomero 18 'Summit White Medium Soft Pink' (IR2985-121)")).toEqual({ model: 'Vomero 18', sure: true });
    expect(m('LEGO x Nike Dunk Low GS Sail (IF2117-100)')).toEqual({ model: 'Dunk Low', sure: true });
    expect(m('adidas Adizero Evo SL White Pure Teal - JS4487')).toEqual({ model: 'Adizero Evo SL', sure: true });
    expect(m("Nike Wmns A'One 'White Sapphire' (FZ8605-104)")).toEqual({ model: "A'One", sure: true });
    expect(m('Nike Kobe 8 Protro TB Gym Red White (HM6469-601)')).toEqual({ model: 'Kobe 8 Protro', sure: true });
    expect(m('Nike Zoom LeBron NXXT Gen Grey Black (DR8784-005)')).toEqual({ model: 'Zoom LeBron NXXT Gen', sure: true });
    expect(m('New Balance 9060 Sea Salt Bone (U9060BLZ)')).toEqual({ model: '9060', sure: true });
    expect(m('New Balance 990v4 MiUSA Teddy Santis Grey Black Cream (U990TG4)')).toEqual({ model: '990v4', sure: true });
    expect(m('ASICS Gel NYC Concrete Barely Rose (1203A383-028)')).toEqual({ model: 'Gel-NYC', sure: true });
    expect(m('A Bathing Ape Bape Sta #3 White (1K80191303 WHT)')).toEqual({ model: 'Bapesta', sure: true });
    expect(m('JORDAN FLIGHT COURT MENS - HF3255-005')).toEqual({ model: 'Jordan Flight Court', sure: true });
    // not a known family → a guess, never sure (the 2-word fallback / everything before a quoted colourway)
    expect(m('Nike Zoom Hyperflight Unseen Hours DMV (IX0704-600)')).toEqual({ model: 'Zoom Hyperflight', sure: false });
    expect(m("Nike Motive 'Black Anthracite' (DV1237-001)")).toEqual({ model: 'Motive', sure: false });
    expect(m("Supreme x Jordan Track Jacket 'Black' (IR6453-010)").sure).toBe(false);   // apparel
    expect(m('')).toEqual({ model: '', sure: false });
    expect(m(null)).toEqual({ model: '', sure: false });
  });

  test('shoeModel: typed for the shoe → the title when sure → a guess (blocked)', () => {
    expect(shoeModel({ title: 'Nike Air Max 90 Premium Aurora Green Camo (IF1721-100)', overrides: own('Air Max 90'), productTypeId: PT })).toEqual({ model: 'Air Max 90', from: 'shoe', sure: true });
    expect(shoeModel({ title: 'Nike Air Max 90 Premium Aurora Green Camo (IF1721-100)', overrides: own('Air Max 90', 1852), productTypeId: PT })).toEqual({ model: 'Air Max 90 Premium', from: 'title', sure: true });   // typed under another type
    expect(shoeModel({ title: "Nike Motive 'Black Anthracite' (DV1237-001)", overrides: null, productTypeId: PT })).toEqual({ model: 'Motive', from: null, sure: false, guess: true });
  });

  test('shoeAttrDefaults: typed wins → title when sure (shoe: true, from: title) → nothing; only 1000546, only when the template lists it; Setup typed rows dropped', () => {
    const title = 'Nike LeBron 23 Out for Redemption (IH1513-400)';
    const rows = shoeAttrDefaults(SETUP, null, PT, { title, template: TEMPLATE });
    // Setup's "ACG Air Max" and "Air Max" (typed) are gone; the picked default stays; the model comes from the title
    expect(rows.map((r) => [r.attribute_id, r.extra_values, !!r.shoe, r.from || null])).toEqual([[7000, [], false, null], [PRODUCT_MODEL_ATTR_ID, ['LeBron 23'], true, 'title']]);
    // the person's typed value ALWAYS wins
    const typed = shoeAttrDefaults(SETUP, own('LeBron XXIII'), PT, { title, template: TEMPLATE });
    expect(typed.filter((r) => r.attribute_id === PRODUCT_MODEL_ATTR_ID)).toEqual([expect.objectContaining({ extra_values: ['LeBron XXIII'], shoe: true, from: 'shoe' })]);
    // an unsure title adds nothing
    expect(shoeAttrDefaults(SETUP, null, PT, { title: "Nike Motive 'Black Anthracite' (DV1237-001)", template: TEMPLATE }).some((r) => r.attribute_id === PRODUCT_MODEL_ATTR_ID)).toBe(false);
    // the template doesn't list Product Model → no title row
    expect(shoeAttrDefaults(SETUP, null, PT, { title, template: NO_MODEL }).some((r) => r.attribute_id === PRODUCT_MODEL_ATTR_ID)).toBe(false);
    // no template / no title → no title row, and Setup's Product Model is still never passed on
    expect(shoeAttrDefaults(SETUP, null, PT).map((r) => r.attribute_id)).toEqual([7000, 1002319]);
    expect(typedAttrIds(TEMPLATE)).toEqual(new Set([PRODUCT_MODEL_ATTR_ID, 1002319]));
  });

  test('publish (buildAttributes): no store-wide default — a Setup typed row is ignored; the title / typed model is sent; unsure stays blocked', () => {
    const parts = templateParts(TEMPLATE);
    // the raw Setup rows (as the old code passed them) → still "type it for this shoe"
    const leak = buildAttributes({ parts, defaults: SETUP });
    expect(leak.rows).toEqual([{ attribute_id: 7000, attribute_value_id: 7001 }]);
    expect(leak.problems).toEqual([expect.objectContaining({ code: 'missing_attr', params: { attributeId: PRODUCT_MODEL_ATTR_ID, attribute: 'Product Model', why: 'typed_per_shoe' } })]);
    // two shoes of the SAME product type → each its own model
    const a = shoeAttrDefaults(SETUP, null, PT, { title: 'Nike Air Max 270 White Metallic Gold Black (AV7892-100)', template: TEMPLATE });
    const b = shoeAttrDefaults(SETUP, null, PT, { title: 'Nike KD 19 Field Purple (IH1117-500)', template: TEMPLATE });
    const ra = buildAttributes({ parts, defaults: a }); const rb = buildAttributes({ parts, defaults: b });
    expect(ra.rows).toEqual([{ attribute_id: 7000, attribute_value_id: 7001 }, { attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_extra_value: 'Air Max 270' }]);
    expect(rb.rows).toEqual([{ attribute_id: 7000, attribute_value_id: 7001 }, { attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_extra_value: 'KD 19' }]);
    expect(modelOf(ra.rows, a)).toEqual({ value: 'Air Max 270', from: 'title' });
    // typed beats the title
    const t = shoeAttrDefaults(SETUP, own('Air Max 270 React'), PT, { title: 'Nike Air Max 270 White (AV7892-100)', template: TEMPLATE });
    const rt = buildAttributes({ parts, defaults: t });
    expect(rt.rows).toContainEqual({ attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_extra_value: 'Air Max 270 React' });
    expect(modelOf(rt.rows, t)).toEqual({ value: 'Air Max 270 React', from: 'shoe' });
    // unsure → blocked, nothing sent
    const u = buildAttributes({ parts, defaults: shoeAttrDefaults(SETUP, null, PT, { title: "Nike Motive 'Black Anthracite' (DV1237-001)", template: TEMPLATE }) });
    expect(u.rows.some((r) => r.attribute_id === PRODUCT_MODEL_ATTR_ID)).toBe(false);
    expect(u.problems[0]).toMatchObject({ code: 'missing_attr', params: { why: 'typed_per_shoe' } });
  });

  test('live edit (attributePatch): the title’s sure model is accepted (and says so); Setup’s typed text never; unsure stays blocked', () => {
    const spu = { spuName: 'E2EMODEL', productAttributeInfoList: [cur(7000, 7001)] };
    const title = 'Nike Air Monarch IV Black (415445-001)';
    const p = attributePatch({ spu, template: TEMPLATE, defaults: shoeAttrDefaults(SETUP, null, PT, { title, template: TEMPLATE }) });
    expect(p).toMatchObject({ list: [{ attribute_id: 7000, attribute_value_id: 7001 }, { attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_extra_value: 'Air Monarch IV' }], problems: [] });
    expect(p.added).toEqual([{ attributeId: PRODUCT_MODEL_ATTR_ID, attribute: 'Product Model', from: 'title', value: 'Air Monarch IV' }]);
    // Setup's rows as they are ("ACG Air Max") → blocked
    expect(attributePatch({ spu, template: TEMPLATE, defaults: SETUP })).toMatchObject({ list: null, problems: [expect.objectContaining({ params: expect.objectContaining({ why: 'typed_per_shoe' }) })] });
    // unsure → blocked
    expect(attributePatch({ spu, template: TEMPLATE, defaults: shoeAttrDefaults(SETUP, null, PT, { title: 'Nike ST Charge Cade Cunningham Bowie (IZ6735-800)', template: TEMPLATE }) }).list).toBe(null);
    // the shoe's typed value → sent, no "from the title"
    const t = attributePatch({ spu, template: TEMPLATE, defaults: shoeAttrDefaults(SETUP, own('Air Monarch IV 4E'), PT, { title, template: TEMPLATE }) });
    expect(t.list).toContainEqual({ attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_extra_value: 'Air Monarch IV 4E' });
    expect(t.added).toEqual([{ attributeId: PRODUCT_MODEL_ATTR_ID, attribute: 'Product Model' }]);
    // a product already carrying a model on SHEIN → nothing to add, nothing sent
    expect(attributePatch({ spu: { ...spu, productAttributeInfoList: [cur(7000, 7001), cur(PRODUCT_MODEL_ATTR_ID, null, 'ACG Air Max')] }, template: TEMPLATE, defaults: shoeAttrDefaults(SETUP, null, PT, { title, template: TEMPLATE }) }).list).toBe(null);
  });

  test('setupModelCorrections (read-only report): a sent Setup default that isn’t the shoe’s own model', () => {
    const body = (model) => ({ product_type_id: PT, product_attribute_list: [{ attribute_id: 7000, attribute_value_id: 7001 }, { attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_extra_value: model }] });
    const setup = new Map([[PT, ['ACG Air Max']], [374, ['Dunk Low']]]);
    const rows = [
      { shopify_product_id: 'gid://shopify/Product/1', spu: 'S1', title: 'Nike LeBron 23 Out for Redemption (IH1513-400)', product_type_id: PT, body: body('ACG Air Max') },          // wrong → LeBron 23
      { shopify_product_id: 'gid://shopify/Product/2', spu: 'S2', title: 'Nike ACG Air Max Goadome Triple Black (865031-009)', product_type_id: PT, body: body('ACG Air Max') },         // title says Goadome
      { shopify_product_id: 'gid://shopify/Product/3', spu: 'S3', title: 'Nike Dunk Low Panda (DD1391-100)', product_type_id: 374, body: body('Dunk Low') },                                 // the default happened to be right
      { shopify_product_id: 'gid://shopify/Product/4', spu: 'S4', title: 'Nike Air Max 90 (X)', product_type_id: PT, body: body('Air Max 90') },                                             // a person's value, not Setup's
      { shopify_product_id: 'gid://shopify/Product/5', spu: 'S5', title: "Nike Motive 'Black' (DV1237-001)", product_type_id: PT, body: body('ACG Air Max') },                              // no model we can read
      { shopify_product_id: 'gid://shopify/Product/6', spu: 'S6', title: 'Nike Kobe 10 Low Protro (IQ5339-400)', product_type_id: PT, attr_overrides: own('Kobe X Low Protro'), body: body('ACG Air Max') },
    ];
    const out = setupModelCorrections(rows, setup);
    expect(out.map((r) => [r.spu, r.sent, r.should, r.from, r.reason])).toEqual([
      ['S1', 'ACG Air Max', 'LeBron 23', 'title', 'setup_default_differs'],
      ['S2', 'ACG Air Max', 'ACG Air Max Goadome', 'title', 'setup_default_differs'],
      ['S5', 'ACG Air Max', null, null, 'setup_default_no_model'],
      ['S6', 'ACG Air Max', 'Kobe X Low Protro', 'shoe', 'setup_default_differs'],
    ]);
    expect(out[2].guess).toBe('Motive');
    // 2026-11-14: a wrong model that ISN'T today's Setup value (Setup changed since, or its rows were deleted) still counts;
    // an unsure shoe with a non-Setup value is left alone; a fix already sent is passed through (never a candidate again)
    const more = setupModelCorrections([
      { shopify_product_id: 'gid://shopify/Product/7', spu: 'S7', title: 'Nike Gato LV8 Chrome (IB3566-001)', product_type_id: PT, body: body('Dunk Low') },
      { shopify_product_id: 'gid://shopify/Product/8', spu: 'S8', title: "Nike Motive 'Black' (DV1237-001)", product_type_id: PT, body: body('Motive X') },
      { shopify_product_id: 'gid://shopify/Product/9', spu: 'S9', title: 'Nike KD 19 (IH1117-500)', product_type_id: PT, body: body('ACG Air Max'), fix_status: 'in_review', fix_job_id: '42' },
    ], setup);
    expect(more.map((r) => [r.spu, r.sent, r.should, r.reason, r.fixStatus, r.fixJobId])).toEqual([
      ['S7', 'Dunk Low', 'Gato LV8', 'sent_differs', null, null],
      ['S9', 'ACG Air Max', 'KD 19', 'setup_default_differs', 'in_review', 42],
    ]);
  });
});

// Teammate pilot 2026-11-13 (HF2886-001, men's 8824): SHEIN's placeholder colour is labelled
// "Color default" there — it passed the real-colour check (main_attribute_status 3) and the pickers
// offered it. One rule now (isDefaultLabel) for the planner and both colour pickers.
test('SHEIN placeholder colour: "Color default" counts as the default, real colours do not (pure)', async () => {
  const { isDefaultLabel } = await import('../src/lib/sheinPublish.js');
  for (const l of ['Default', 'default', 'Color default', 'Colour Default', 'color_default', '默认', '颜色默认']) expect(isDefaultLabel(l)).toBe(true);
  for (const l of ['Black', 'Default Grey', 'White/Default', 'Multicolor', '', null]) expect(isDefaultLabel(l)).toBe(false);
});

// 2026-11-14 (owner approved): correct the Product Model of a shoe already live on SHEIN (op 'model').
test.describe('SHEIN Product Model fix of a LIVE shoe — planModelFix (pure)', () => {
  const LINING = { attribute_id: 7200, attribute_name_en: 'Lining Material', attribute_type: 4, attribute_mode: 3, attribute_status: 2, data_dimension: 1, attribute_value_info_list: [{ attribute_value_id: 7201, attribute_value_en: 'Fabric' }] };
  const TPL = { product_type_id: PT, main_attribute_status: 2, attribute_infos: [{ attribute_id: 27, attribute_type: 1, attribute_label: 1, attribute_status: 3 }, UPPER, LINING, MODEL, SERIES] };
  const live = (model, extra = []) => ({ spuName: 'S1', productAttributeInfoList: [cur(7000, 7001), cur(27, 81), cur(1002319, null, 'Air Max'), ...(model ? [cur(MODEL.attribute_id, null, model)] : []), cur(5555, 1), ...extra] });
  const defs = (title, overrides = null) => shoeAttrDefaults(SETUP, overrides, PT, { title, template: TPL });

  test('the body: the CURRENT list as SHEIN has it with ONLY 1000546 swapped — nothing else (no sizes, prices, photos, SKC fields)', () => {
    const r = planModelFix({ spu: live('ACG Air Max'), template: TPL, defaults: defs('Nike LeBron 23 Out for Redemption (IH1513-400)') });
    expect(r.body).toEqual({ spu_name: 'S1', product_attribute_list: [{ attribute_id: 7000, attribute_value_id: 7001 }, { attribute_id: 1002319, attribute_extra_value: 'Air Max' }, { attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_extra_value: 'LeBron 23' }] });
    expect(r.plan).toMatchObject({ op: 'model', model: { from: 'ACG Air Max', to: 'LeBron 23', source: 'title' }, attributes: { added: [], dropped: [5555], count: 3 }, blockers: [] });
    // every other row is exactly what currentAttrRows (= what attributePatch keeps) reads
    const keep = [...currentAttrRows(live('ACG Air Max'), TPL).cur.values()].filter((x) => x.attribute_id !== PRODUCT_MODEL_ATTR_ID);
    expect(r.body.product_attribute_list.filter((x) => x.attribute_id !== PRODUCT_MODEL_ATTR_ID)).toEqual(keep);
    expect(summarizePlan(r.plan)).toBe('Product Model: “ACG Air Max” → “LeBron 23” (from the title) · every other detail sent as SHEIN has it (SHEIN reviews every colour)');
  });
  test('typed for the shoe wins over the title; a missing required detail is added (as attributePatch would); one it can’t fill blocks', () => {
    const t = planModelFix({ spu: live('ACG Air Max'), template: TPL, defaults: defs('Nike LeBron 23 (IH1513-400)', own('LeBron XXIII')) });
    expect(t.body.product_attribute_list.at(-1)).toEqual({ attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_extra_value: 'LeBron XXIII' });
    expect(t.plan.model).toMatchObject({ to: 'LeBron XXIII', source: 'shoe' });
    // a leather upper makes the lining required (an associated rule); Setup has a lining default → it rides along
    const withLining = [...defs('Nike LeBron 23 (IH1513-400)'), { product_type_id: PT, attribute_id: 7200, value_ids: [7201], extra_values: [] }];
    const a = planModelFix({ spu: live('ACG Air Max'), template: TPL, defaults: withLining, assoc: [{ attribute_id: 7200, allowed: [7201] }] });
    expect(a.body.product_attribute_list).toEqual([{ attribute_id: 7000, attribute_value_id: 7001 }, { attribute_id: 1002319, attribute_extra_value: 'Air Max' }, { attribute_id: 7200, attribute_value_id: 7201 }, { attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_extra_value: 'LeBron 23' }]);
    expect(a.plan.attributes.added).toEqual([{ attributeId: 7200, attribute: 'Lining Material' }]);
    // no lining default → SHEIN would refuse the whole edit → blocked here, nothing sent
    const b = planModelFix({ spu: live('ACG Air Max'), template: TPL, defaults: defs('Nike LeBron 23 (IH1513-400)'), assoc: [{ attribute_id: 7200, allowed: [7201] }] });
    expect(b.body).toBe(null);
    expect(b.plan.blockers[0]).toMatchObject({ code: 'missing_attr', params: expect.objectContaining({ attributeId: 7200 }) });
    // a live shoe with NO model on SHEIN gets one (from: none)
    const n = planModelFix({ spu: live(null), template: TPL, defaults: defs('Nike Air Monarch IV Black (415445-001)') });
    expect(n.body.product_attribute_list.at(-1)).toEqual({ attribute_id: PRODUCT_MODEL_ATTR_ID, attribute_extra_value: 'Air Monarch IV' });
    expect(n.plan.model).toMatchObject({ from: null, to: 'Air Monarch IV' });
  });
  test('never sent: unsure title (the guess is shown) · already right (case / spaces aside) · the type has no Product Model · template unread', () => {
    const u = planModelFix({ spu: live('ACG Air Max'), template: TPL, defaults: defs("Nike Motive 'Black Anthracite' (DV1237-001)"), guess: 'Motive' });
    expect(u).toMatchObject({ body: null, plan: { blockers: [expect.objectContaining({ code: 'model_unsure', params: { current: 'ACG Air Max', guess: 'Motive' } })] } });
    // Setup's "ACG Air Max" is never a source for the fix either
    expect(planModelFix({ spu: live('Dunk Low'), template: TPL, defaults: SETUP }).plan.blockers[0].code).toBe('model_unsure');
    const ok = planModelFix({ spu: live('air  max 270'), template: TPL, defaults: defs('Nike Air Max 270 White (AV7892-100)') });
    expect(ok).toMatchObject({ body: null, plan: { blockers: [expect.objectContaining({ code: 'model_already_right', params: { model: 'air  max 270' } })] } });
    expect(planModelFix({ spu: live('ACG Air Max'), template: NO_MODEL, defaults: defs('Nike Air Max 270 (AV7892-100)') }).plan.blockers[0].code).toBe('model_not_in_template');
    expect(planModelFix({ spu: live('ACG Air Max'), template: null, defaults: [] }).plan.blockers[0]).toMatchObject({ code: 'missing_attr', params: { why: 'template_unread' } });
  });
});
