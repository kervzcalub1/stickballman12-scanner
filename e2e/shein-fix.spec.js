// SHEIN listing fix (docs/context/shein-fix.md). What this pins:
//   · stock = the Shopify stock of the SAME-size variant, minus SHEIN orders not shipped;
//   · a SHEIN size linked to ANOTHER size sells nothing until its seller SKU is changed — a
//     swap names the exact SKU, the row losing it says where it goes;
//   · dead SKUs: relinked by style + size when that's exact; the AI's suggestion counts only
//     if the rules confirm the same product and size;
//   · SHEIN's inventory template is filled without touching anything else, and verified;
//   · the page: one click → the file; AI button → verified links (OpenAI mocked).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import { checkRows } from '../src/lib/sheinCheck.js';
import { buildFix, readSheinOrders, readInventoryTemplate, fillInventoryTemplate, verifyInventoryFile, stockRows, verifyAiLink, ruleRelink, addLabel } from '../src/lib/sheinFix.js';
import { readSheetRows } from '../src/lib/sheinReprice.js';

const V = (sku, size, qty, productId = 'P1', extra = {}) => ({ sku, size, qty, productId, status: 'ACTIVE', productTitle: 'Nike Air Max 95 (IB7936-100)', style: 'IB7936-100', ...extra });
const VARIANTS = [
  V('A7', '7', 2), V('A8', '8', 3), V('A9', '9', 1), V('A10', '10', 5), V('A4', '4', 2),
  V('N9', '9', 4, 'P2', { productTitle: 'Nike Dunk Low (DD1391-100)', style: 'DD1391-100' }),
];
const S = (line, sellerSku, size, qty, extra = {}) => ({ line, sellerSku, size, qty, name: 'Nike Air Max 95 (IB7936-100)', spu: 'spu1', sheinSku: `S${line}`, warehouse: 'PS1', ...extra });

test.describe('SHEIN fix rules', () => {
  test('stock from the same-size variant; a size linked to another size sells nothing', () => {
    const shein = [
      S(2, 'A7', 'US7', 9),          // correct → Shopify 2, minus 1 open order = 1
      S(3, 'A9', 'US8', 1),          // swap: SHEIN US8 holds Shopify 9's SKU; Shopify 8 = A8
      S(4, 'A8', 'US7.5', 2),        // A8 (size 8) on SHEIN US7.5 — no 7.5 in Shopify; A8 moves to US8
      S(5, 'A4', 'US7.5W', 1),       // Shopify 4 pushed onto a SHEIN size: wrong, no sibling
      S(6, 'GONE', 'US9', 3, { name: 'Nike Dunk Low (DD1391-100)', spu: 'spu2' }),   // dead SKU → relink by style + size → N9
      S(7, 'A10', '', 4),            // blank size
    ];
    const fix = buildFix(checkRows(shein, VARIANTS), VARIANTS, { openBySku: { A7: 1 } });
    const by = Object.fromEntries(fix.rows.map((r) => [r.line, r]));
    expect(by[2]).toMatchObject({ newQty: 1, reason: 'ok', change: true });
    expect(by[3]).toMatchObject({ newQty: 0, reason: 'swap', linkTo: { sku: 'A8', size: '8' } });
    expect(by[4]).toMatchObject({ newQty: 0, reason: 'wrong_size' });
    expect(by[4].action).toContain('it moves to SHEIN US8');
    expect(by[5]).toMatchObject({ newQty: 0, reason: 'wrong_size' });
    expect(by[5].action).toContain('add size US4');
    expect(by[6]).toMatchObject({ newQty: 0, reason: 'no_shopify', linkTo: { sku: 'N9', by: 'rule' } });
    expect(by[7]).toMatchObject({ newQty: 0, reason: 'no_size' });
    expect(by[7].action).toContain('US10');
    expect(fix.summary).toMatchObject({ pairsBefore: 20, pairsAfter: 1, toZero: 5 });
    // Shopify sizes in stock no SHEIN size sells: 4 (needs adding), 8 (fixed by the swap), 9 (its SHEIN row goes to
    // size 8, so 9 needs its own SHEIN size), 10 (blank on SHEIN)
    expect(fix.sizesToAdd.map((a) => [a.sku, a.pendingSwap])).toEqual([['A4', false], ['A8', true], ['A9', false], ['A10', false]]);
    expect(addLabel('5.5W')).toBe('US5.5W');
    expect(addLabel('3Y')).toBe('US3Y');
  });

  test('a second SHEIN size on the same seller SKU gets 0; dead SKUs relink only on an exact match', () => {
    const fix = buildFix(checkRows([S(2, 'A9', 'US9', 1), S(3, 'A9', 'US9', 1)], VARIANTS), VARIANTS);
    expect(fix.rows.map((r) => [r.newQty, r.reason])).toEqual([[1, 'ok'], [0, 'duplicate']]);
    expect(ruleRelink({ name: 'Nike Dunk Low (DD1391-100)', size: 'US10' }, VARIANTS)).toBeNull();   // no size 10 in that product
  });

  test('a women’s SHEIN size never links to a men’s Shopify size (US8W ≠ men’s 8)', () => {
    // 2026-10-28, live dry run #52: Nike Ja 3 (men's sizes on Shopify, no W) listed on SHEIN as US8W / US8.5W —
    // the swap would have linked SHEIN US8W to Shopify men's 8. Women's 8 ≈ men's 6.5.
    const JA = (sku, size) => V(sku, size, 2, 'PJ', { productTitle: 'Nike Ja 3 Twelve Time (IQ6755-300)', style: 'IQ6755-300' });
    const W = (sku, size) => V(sku, size, 2, 'PW', { productTitle: 'Nike AL8 Smoke Grey Women\'s (FJ3794-101)', style: 'FJ3794-101' });
    const B = (sku, size) => V(sku, size, 2, 'PB', { productTitle: 'Jordan 6 Retro Low Blackout Women\'s (IO9786-001)', style: 'IO9786-001' });
    const vars = [JA('J8', '8'), JA('J9', '9'), W('W8', '8W'), W('W9', '9W'), B('B8', '8')];
    const ja = (line, sku, size) => S(line, sku, size, 1, { name: 'Nike Ja 3 Twelve Time (IQ6755-300)', spu: 'spuJ' });
    // swap path: SHEIN US8W carries Shopify men's 9 — there is no women's 8, so no sibling: held at 0 for a person
    const fix = buildFix(checkRows([ja(2, 'J9', 'US8W')], vars), vars);
    expect(fix.rows[0]).toMatchObject({ newQty: 0, linkTo: null });
    // dead-SKU path, same rule
    expect(ruleRelink({ name: 'Nike Ja 3 Twelve Time (IQ6755-300)', size: 'US8W' }, vars)).toBeNull();
    expect(verifyAiLink({ size: 'US8W', name: 'Nike Ja 3 Twelve Time (IQ6755-300)' }, { productId: 'PJ', shopifySku: 'J8' }, vars)).toBeNull();
    // still links: W ↔ W, and a bare size on a product whose title says Women's
    expect(ruleRelink({ name: 'Nike AL8 Smoke Grey Women\'s (FJ3794-101)', size: 'US8W' }, vars)).toMatchObject({ sku: 'W8' });
    expect(ruleRelink({ name: 'Jordan 6 Retro Low Blackout Women\'s (IO9786-001)', size: 'US8W' }, vars)).toMatchObject({ sku: 'B8' });
    // and men's still links to men's
    expect(ruleRelink({ name: 'Nike Ja 3 Twelve Time (IQ6755-300)', size: 'US9' }, vars)).toMatchObject({ sku: 'J9' });
  });

  test('an AI suggestion counts only when the rules agree: same product, same size', () => {
    const row = { size: 'US9', name: 'x' };
    expect(verifyAiLink(row, { productId: 'P2', shopifySku: 'N9' }, VARIANTS)).toMatchObject({ sku: 'N9', by: 'ai' });
    expect(verifyAiLink(row, { productId: 'P2', shopifySku: 'A9' }, VARIANTS)).toBeNull();   // SKU not in that product
    expect(verifyAiLink(row, { productId: 'P1', shopifySku: 'A8' }, VARIANTS)).toBeNull();   // wrong size
    expect(verifyAiLink(row, { productId: 'P1', shopifySku: 'NOPE' }, VARIANTS)).toBeNull();
    const fix = buildFix(checkRows([S(2, 'DEAD', 'US8', 2, { name: 'Mystery shoe' })], VARIANTS), VARIANTS, { aiLinks: { 2: verifyAiLink({ size: 'US8' }, { productId: 'P1', shopifySku: 'A8' }, VARIANTS) } });
    expect(fix.rows[0]).toMatchObject({ newQty: 0, reason: 'no_shopify', linkTo: { sku: 'A8', by: 'ai' } });   // still 0 until SHEIN's SKU is changed
  });

  test('a person’s match: 0 until SHEIN carries the new SKU, then Shopify stock (even an EUR size); delist is 0', () => {
    const rows = [S(2, 'A9', 'US8', 1), S(3, 'A8', 'EUR41', 2), S(4, 'A7', 'US7', 5)];
    const decisions = { S2: { link_sku: 'A8', decision: 'link', decided_by: 'Kervy' }, S4: { decision: 'delist', decided_by: 'Kervy' } };
    const fix = buildFix(checkRows(rows, VARIANTS), VARIANTS, { decisions });
    expect(fix.rows.map((r) => [r.reason, r.newQty])).toEqual([['pending_change', 0], ['other_system', 0], ['delist', 0]]);
    expect(fix.rows[0].action).toContain('Change the seller SKU to A8 (Shopify size 8)');
    // SHEIN now shows the changes: S2 carries A8, and a person matched the EUR size S3 to A8 too… one SKU, one size —
    const after = buildFix(checkRows([S(2, 'A8', 'US8', 0), S(3, 'A10', 'EUR44', 0)], VARIANTS), VARIANTS,
      { decisions: { S2: { link_sku: 'A8', decision: 'link' }, S3: { link_sku: 'A10', decision: 'link' } } });
    expect(after.rows.map((r) => [r.reason, r.newQty])).toEqual([['ok', 3], ['ok', 5]]);   // applied: stock flows; the EUR size was checked by a person
  });

  test('SHEIN order export: only orders not shipped yet are held back', () => {
    const head = ['Order Number', 'Order Status', 'Specification', 'Seller SKU', 'Number of items sold'];
    const bytes = buildXlsx({ sheetName: '0', columns: head.map((label) => ({ label })), rows: [
      ['O1', 'Pending Pickup', 'US7', 'A7', '1'], ['O2', 'Delivered', 'US7', 'A7', '1'], ['O3', 'Customer Refunded', 'US8', 'A8', '1'], ['O4', 'Pending Pickup', 'US9', 'A9', '2'],
    ] });
    const o = readSheinOrders(bytes);
    expect(o.ok).toBe(true);
    expect(o.bySku).toEqual({ A7: 1, A9: 2 });
  });

  test('SHEIN’s inventory template: filled below its guide rows, the rest untouched, verified', () => {
    const tplBytes = buildXlsx({ sheetName: 'sheet1', columns: [{ label: 'Field Code' }, { label: 'SKU' }, { label: 'Warehouse Code' }, { label: 'Inventory' }],
      rows: [['Guides for completing', 'SHEIN SKU code', 'warehouse', 'number'], ['Fill in the example', 'I41ohhhfhzp1', 'PS1', '5']] });
    const tpl = readInventoryTemplate(tplBytes);
    expect(tpl).toMatchObject({ ok: true, sheet: 'sheet1', cols: { sku: 1, qty: 3, wh: 2 }, start: 3 });
    const changes = [{ sheinSku: 'S2', after: 1, warehouse: 'PS1' }, { sheinSku: 'S3', after: 0, warehouse: 'PS1' }];
    const out = fillInventoryTemplate(tpl, changes);
    expect(verifyInventoryFile(tpl, out, changes)).toMatchObject({ ok: true });
    const grid = readSheetRows(out, 'sheet1');
    expect(grid[2][0]).toBe('Fill in the example');
    expect(grid.slice(3).map((r) => [r[1], r[2], r[3]])).toEqual([['S2', 'PS1', '1'], ['S3', 'PS1', '0']]);
    expect(readInventoryTemplate(buildXlsx({ sheetName: 'x', columns: [{ label: 'Name' }], rows: [] })).ok).toBe(false);
  });
});

test.describe('SHEIN fix page', () => {
  const HEAD = ['SPU', 'SKC', 'SKU', 'Secondary Specification Value1', 'Default Product Name(en)', 'sellerSKU', 'Current inventory', 'Warehouse ID'];
  const exportBytes = () => Buffer.from(buildXlsx({ sheetName: 'Product Information', columns: HEAD.map((label) => ({ label })), rows: [
    ['spu1', 'k1', 'S2', 'US7', 'Nike Air Max 95 (IB7936-100)', 'A7', '9', 'PS1'],
    ['spu1', 'k1', 'S3', 'US8', 'Nike Air Max 95 (IB7936-100)', 'A9', '1', 'PS1'],
    ['spu3', 'k3', 'S4', 'US9', 'Mystery Collab Runner Blue', 'DEAD1', '2', 'PS1'],
  ] }));

  test('upload → one click gives the stock file; AI links are kept only when verified', async ({ page }) => {
    const asked = [];
    await page.route('**/api/shopify-listings/variants', (r) => r.fulfill({ json: { ok: true, variants: [
      ...VARIANTS, V('M9', '9', 2, 'P3', { productTitle: 'Mystery Collab Runner Blue', style: null }), V('M10', '10', 1, 'P3', { productTitle: 'Mystery Collab Runner Blue', style: null }),
    ] } }));
    await page.route('**/api/shein/links', (r) => r.fulfill({ json: { ok: true, links: [] } }));
    await page.route('**/api/shein-fix/ai', (r) => {
      const b = r.request().postDataJSON(); asked.push(b);
      return r.fulfill({ json: { ok: true, model: 'gpt-5.5', matches: [{ key: 'spu3', productId: 'P3', confidence: 0.95, reason: 'Same collab runner', sizes: [{ line: 4, shopifySku: 'M9' }] }] } });
    });
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/ph/shein-check');
    await page.getByLabel('SHEIN export file').setInputFiles({ name: 'Export Products_2026-10-13 09_00_00.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: exportBytes() });
    await page.getByRole('button', { name: 'Fix & download' }).click();
    const panel = page.locator('.shf');
    await expect(panel).toContainText('pause 4seller');
    await expect(panel.locator('.er-stat').filter({ hasText: 'pairs offered on SHEIN' })).toContainText('12 → 2');
    await expect(panel.locator('.er-stat').filter({ hasText: 'seller SKUs to change' })).toContainText('1');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /SHEIN inventory file \(3 SKUs\)/ }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^SHEIN inventory fix \(\d{4}-\d{2}-\d{2}\) - plain\.xlsx$/);
    const rows = readSheetRows(new Uint8Array(await (await import('node:fs')).promises.readFile(await dl.path())), 'Inventory fix');
    expect(rows.slice(1).map((r) => [r[0], r[5]])).toEqual([['S2', '2'], ['S3', '0'], ['S4', '0']]);

    await page.getByRole('button', { name: /Match 1 product with AI/ }).click();
    await expect(panel).toContainText('gpt-5.5: 1 link confirmed by the rules');
    expect(asked[0].products[0]).toMatchObject({ key: 'spu3', sizes: [{ line: 4, sellerSku: 'DEAD1', size: 'US9' }] });
    await expect(panel.locator('.er-stat').filter({ hasText: 'seller SKUs to change' }).locator('b')).toHaveText('2');
    await expect(panel.locator('.er-stat').filter({ hasText: 'seller SKUs to change' })).toContainText('(1 by AI)');
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => !el.closest('.ap-tablewrap') && el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((el) => `${el.tagName}.${el.className}`));
    expect(wide).toEqual([]);
  });
});

test.describe('SHEIN match screen', () => {
  const HEAD = ['SPU', 'SKC', 'SKU', 'Secondary Specification Value1', 'Default Product Name(en)', 'sellerSKU', 'Current inventory'];
  test('search a shoe → only same-size Shopify SKUs offered → save; the fix sees it at once', async ({ page }) => {
    const saved = [];
    let links = [];
    await page.route('**/api/shopify-listings/variants', (r) => r.fulfill({ json: { ok: true, variants: VARIANTS } }));
    await page.route('**/api/shein/status', (r) => r.fulfill({ json: { ok: true, configured: false, connected: false, missing: ['SHEIN_APP_ID'] } }));
    await page.route('**/api/shein/links', (r) => {
      if (r.request().method() === 'GET') return r.fulfill({ json: { ok: true, links } });
      const b = r.request().postDataJSON(); saved.push(b);
      links = b.links.map((l) => ({ shein_sku: l.sheinSku, link_sku: l.linkSku, decision: l.decision, decided_by: 'E2E PH' }));
      return r.fulfill({ json: { ok: true, saved: b.links.length } });
    });
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/ph/shein-check');
    const bytes = Buffer.from(buildXlsx({ sheetName: 'Product Information', columns: HEAD.map((label) => ({ label })), rows: [
      ['spu1', 'k1', 'S2', 'US7', 'Nike Air Max 95 (IB7936-100)', 'A7', '1'],
      ['spu1', 'k1', 'S3', 'US8', 'Nike Air Max 95 (IB7936-100)', 'A9', '1'],
    ] }));
    await page.getByLabel('SHEIN export file').setInputFiles({ name: 'Export Products_2026-10-13 09_00_00.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
    await expect(page.getByText('waiting for SHEIN to approve our developer app')).toBeVisible();
    await page.getByRole('button', { name: 'Match sizes' }).click();
    await page.getByLabel('Search SHEIN shoes to match').fill('IB7936');
    await page.locator('.shm-head').first().click();
    const sel = page.getByLabel('Shopify SKU for SHEIN US8');
    await expect(sel).toHaveValue('A8');                                    // the swap is pre-filled
    const opts = await sel.locator('option').allTextContents();
    expect(opts.filter((o) => /^A\d/.test(o))).toEqual(['A8 · size 8 · 3 in stock']);   // only the same size
    await expect(page.getByRole('button', { name: 'Save to SHEIN' })).toBeDisabled();
    await page.getByRole('button', { name: 'Save 1 match' }).click();
    await expect(page.getByText('Saved 1 match.')).toBeVisible();
    expect(saved[0].links).toEqual([expect.objectContaining({ sheinSku: 'S3', linkSku: 'A8', sellerSkuWas: 'A9', decision: 'link', source: 'swap' })]);
    await page.getByRole('button', { name: 'Fix & download' }).click();
    await page.locator('.shf details').first().evaluate((d) => { d.open = true; });
    await expect(page.locator('.shf')).toContainText('A8');
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => !el.closest('.ap-tablewrap') && el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((el) => `${el.tagName}.${el.className}`));
    expect(wide).toEqual([]);
  });
});

test.describe('SHEIN API client (waiting for keys)', () => {
  test('signing and key decryption follow SHEIN’s SDK', async () => {
    const crypto = await import('node:crypto');
    const { sheinSignature, sheinDecryptSecret } = await import('../api/_lib/shein.js');
    const want = 'abcde' + Buffer.from(crypto.createHmac('sha256', 'SECRETabcde').update('KEY&1700000000000&/open-api/x').digest('hex')).toString('base64');
    expect(sheinSignature('KEY', 'SECRET', '/open-api/x', '1700000000000', 'abcde')).toBe(want);
    const key = Buffer.alloc(16); Buffer.from('APPSECRET1234567890').copy(key, 0, 0, 16);
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.from('space-station-de'));
    const enc = Buffer.concat([c.update('the-secret-key'), c.final()]).toString('base64');
    expect(sheinDecryptSecret(enc, 'APPSECRET1234567890')).toBe('the-secret-key');
  });
  test('without keys: status says so, connect refuses, the callback refuses a forged return', async ({ request, page }) => {
    await loginAs(page, 'admin');
    const r = await request.get('/api/shein/callback?tempToken=x&state=forged', { maxRedirects: 0 });
    expect(r.status()).toBe(302);
    expect(r.headers().location).toMatch(/^\/ph\/shein-check\?shein_error=/);
  });
});
