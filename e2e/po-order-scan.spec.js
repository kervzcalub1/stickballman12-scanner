// The supplier SCANS their whole-order list (docs/context/purchase-orders.md → "The
// supplier's whole-order list"): po/scan-order takes a supplier through the SAME gate as
// their whole-order paste in po/scan-bulk (`supplierOrderListBlock`), and the window's
// rapid-scan mode puts one pair on the order per barcode, with no dialog — anything that
// can't go straight in waits under "Finish these" for its SKU / size / qty.
// Fixture SKUs, names and barcodes are made up.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const SUPPLIER = 'E2E Order Scan Supplier';
let SUP; let OTHER; let supTok; let otherTok;
const tokenFor = (uid, username, role) => signToken({ uid, username, name: username, role });
const hdr = (t) => ({ Authorization: `Bearer ${t}` });
const PH = tokenFor('e2e-oscan-ph', 'e2e_oscan_ph', 'ph_team');
const WH = tokenFor('e2e-oscan-wh', 'e2e_oscan_wh', 'warehouse');

test.beforeAll(async () => {
  const mk = async (u) => Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$1,'x','supplier','approved')
     ON CONFLICT (username) DO UPDATE SET role='supplier' RETURNING id`, [u]))[0].id);
  SUP = await mk('e2e_oscan_sup'); OTHER = await mk('e2e_oscan_other');
  supTok = tokenFor(SUP, 'e2e_oscan_sup', 'supplier'); otherTok = tokenFor(OTHER, 'e2e_oscan_other', 'supplier');
});
test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q(`DELETE FROM users WHERE username IN ('e2e_oscan_sup','e2e_oscan_other')`);
  await pool.end();
});

async function order({ kind = 'shoes', scope = 'box', status = 'draft', byStore = false, boxLine = false } = {}) {
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, raised_by, expected_boxes, status, order_kind, manifest_scope, by_store)
     VALUES ($1,$2,'supplier',1,$3,$4,$5,$6) RETURNING *`, [SUPPLIER, SUP, status, kind, scope, byStore]))[0];
  const [box] = await q(`INSERT INTO po_boxes (po_id, box_number, status) VALUES ($1, 1, 'pending') RETURNING *`, [po.id]);
  if (boxLine) await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, qty_expected) VALUES ($1,$2,'DZ0000-001','9',1)`, [po.id, box.id]);
  return { po, box };
}
const lines = (poId) => q(`SELECT sku, size, qty_expected::int AS qty, unit_cost::float AS cost, upc, po_box_id, entered_on_behalf, entered_by
                             FROM po_lines WHERE po_id = $1 AND po_box_id IS NULL ORDER BY sku, size`, [poId]);
const scope = async (poId) => (await q('SELECT manifest_scope FROM purchase_orders WHERE id = $1', [poId]))[0].manifest_scope;
const scanOrder = (request, tok, data) => request.post('/api/po/scan-order', { headers: hdr(tok), data });
const bulk = (request, tok, data) => request.post('/api/po/scan-bulk', { headers: hdr(tok), data });

test('a supplier scans onto their own draft: their own line, the same size twice = qty 2, Path C', async ({ request }) => {
  const { po } = await order();
  for (let i = 0; i < 2; i++) {
    const r = await scanOrder(request, supTok, { poId: po.id, sku: 'DZ5485-612', size: '10.5', qty: 1, upc: '000000000017', name: 'Test Shoe' });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  expect(await lines(po.id)).toEqual([
    { sku: 'DZ5485-612', size: '10.5', qty: 2, cost: null, upc: '000000000017', po_box_id: null, entered_on_behalf: false, entered_by: null },
  ]);
  expect(await scope(po.id)).toBe('po');
});

test('supplier gate parity: po/scan-order refuses exactly what the whole-order paste refuses', async ({ request }) => {
  const cases = [
    ['someone else’s order', await order(), otherTok, 403],
    ['not a draft any more', await order({ status: 'receiving' }), supTok, 409],
    ['per-box lines already', await order({ boxLine: true }), supTok, 409],
    ['a buying-request order (order+box)', await order({ scope: 'order+box' }), supTok, 409],
    ['a store order', await order({ byStore: true }), supTok, 409],
    ['an empty-box order', await order({ kind: 'boxes' }), supTok, 409],
  ];
  for (const [what, { po }, tok, code] of cases) {
    const one = await scanOrder(request, tok, { poId: po.id, sku: 'DZ5485-612', size: '9', qty: 1 });
    const paste = await bulk(request, tok, { poId: po.id, shoes: [{ sku: 'DZ5485-612', sizes: [{ size: '9', qty: 1 }] }] });
    expect(one.status(), `${what} (scan): ${await one.text()}`).toBe(code);
    expect(paste.status(), `${what} (paste)`).toBe(code);
    expect((await one.json()).error, what).toBe((await paste.json()).error.replace('paste it as a store list (one "Store:" line per store)', 'add to the store list instead'));
    expect(await lines(po.id), what).toHaveLength(0);
  }
});

test('staff scan-order is unchanged: on-behalf, still open while receiving, boxes allowed; a warehouse login is refused', async ({ request }) => {
  const { po } = await order({ status: 'receiving' });
  const r = await scanOrder(request, PH, { poId: po.id, sku: 'DZ5485-612', size: '9', qty: 3 });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await lines(po.id))[0]).toMatchObject({ qty: 3, entered_on_behalf: true });
  const boxes = await order({ kind: 'boxes' });
  const b = await scanOrder(request, PH, { poId: boxes.po.id, sku: 'DZ5485-612', size: '9', dimensions: '13 x 9 x 5 in' });
  expect(b.ok(), await b.text()).toBeTruthy();
  const perBox = await order({ boxLine: true });
  expect((await scanOrder(request, PH, { poId: perBox.po.id, sku: 'DZ5485-612', size: '9' })).status()).toBe(409);
  const store = await order({ byStore: true });
  expect((await scanOrder(request, PH, { poId: store.po.id, sku: 'DZ5485-612', size: '9' })).status()).toBe(409);
  expect((await scanOrder(request, WH, { poId: po.id, sku: 'DZ5485-612', size: '9' })).status()).toBe(403);
});

/* ------------------------------ the supplier portal ------------------------------ */

const CATALOGUE = {
  upc: {
    '000000000017': { name: 'Test Runner Red', sku: 'DZ5485-612', scannedSize: '10.5', sizes: ['9', '10', '10.5', '11'] },
    '000000000024': { name: 'Test Runner Blue', sku: 'FQ1111-400', sizes: ['8', '9', '10'] },
  },
  sku: {
    'IB4025-100': { name: 'Test Trainer White', sku: 'IB4025-100', sizes: [] },
  },
};
async function portal(page, po) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(([t, u]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u); },
    [supTok, JSON.stringify({ username: 'e2e_oscan_sup', name: SUPPLIER, role: 'supplier' })]);
  await page.route('**/api/upc-search**', (route) => {
    const p = CATALOGUE.upc[JSON.parse(route.request().postData() || '{}').upc];
    return p ? route.fulfill({ json: { ok: true, product: p } })
      : route.fulfill({ status: 404, json: { ok: false, error: 'No product found for that UPC.' } });
  });
  await page.route('**/api/sku-search**', (route) => {
    const p = CATALOGUE.sku[String(JSON.parse(route.request().postData() || '{}').sku || '').toUpperCase()];
    return p ? route.fulfill({ json: { ok: true, product: p } })
      : route.fulfill({ status: 404, json: { ok: false, error: 'No product found for that SKU.' } });
  });
  await page.goto('/orders');
  await page.locator('.po-card').filter({ hasText: po.po_code }).first().click();
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('the supplier portal (phone): rapid-scan the whole order — UPC hits go straight in, misses wait to be finished', async ({ page }) => {
  const { po } = await order();
  await portal(page, po);
  await expect(page.getByRole('button', { name: '📋 Paste the whole-order manifest' })).toBeVisible();
  await page.getByRole('button', { name: '📷 Scan the whole-order manifest' }).click();
  const field = page.getByPlaceholder('Scan or type UPC / SKU');
  await expect(field).toBeVisible();

  // A UPC that names the shoe and its size: one pair at once, no dialog, field still live.
  await field.fill('000000000017'); await field.press('Enter');
  await expect(page.locator('.scan-flash')).toContainText('+1 · DZ5485-612 · 10.5');
  await expect(page.locator('.po-scan-recent')).toContainText('DZ5485-612 · 10.5 · ×1');
  await expect(page.getByRole('dialog')).toHaveCount(1);       // just the window itself
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue('');
  // A gun firing fast: three more of the same box back to back — none lost.
  for (let i = 0; i < 3; i++) { await field.fill('000000000017'); await field.press('Enter'); }
  await expect(page.locator('.po-scan-recent')).toContainText('DZ5485-612 · 10.5 · ×4');
  await expect.poll(async () => (await lines(po.id)).map((l) => [l.sku, l.size, l.qty, l.upc])).toEqual([['DZ5485-612', '10.5', 4, '000000000017']]);

  // A UPC with the shoe but no size: it waits for one; the gun isn't stopped.
  await field.fill('000000000024'); await field.press('Enter');
  // …a code nobody knows, and a SKU typed into the scan field (not in the catalogue).
  await field.fill('000000000031'); await field.press('Enter');
  await field.fill('ZZ9999-001'); await field.press('Enter');
  const cards = page.getByTestId('po-finish');
  await expect(cards).toHaveCount(3);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(await noSideScroll(page)).toBeLessThanOrEqual(0);

  // 1) No size from the barcode → tap a chip, +1 → Add 2.
  const blue = cards.filter({ hasText: 'FQ1111-400' });
  await expect(blue).toContainText('Test Runner Blue');
  await blue.getByRole('button', { name: '9', exact: true }).click();
  await blue.getByRole('button', { name: 'One more' }).click();
  await blue.getByRole('button', { name: 'Add 2 pairs · size 9' }).click();
  await expect(cards).toHaveCount(2);

  // 2) Not found → scan/type the SKU → name fills in → typed size → qty 1 → Add.
  const unknown = cards.filter({ hasText: '000000000031' });
  await unknown.getByLabel('SKU for this shoe').fill('ib4025-100');
  await unknown.getByRole('button', { name: 'Look up' }).click();
  await expect(unknown).toContainText('Test Trainer White');
  await unknown.getByLabel('Typed size for IB4025-100').fill('3Y');
  await unknown.getByLabel('Shelf price ea for IB4025-100').fill('80');
  await unknown.getByRole('button', { name: 'Add 1 pair · size 3Y' }).click();
  await expect(cards).toHaveCount(1);

  // 3) A typed SKU the catalogue doesn't carry still goes in by its code.
  const typed = cards.filter({ hasText: 'ZZ9999-001' });
  await expect(typed).toContainText('not in the catalogue');
  await typed.getByRole('button', { name: '10', exact: true }).click();
  await typed.getByRole('button', { name: 'Add 1 pair · size 10' }).click();
  await expect(cards).toHaveCount(0);

  expect((await lines(po.id)).map((l) => [l.sku, l.size, l.qty, l.cost, l.upc, l.entered_on_behalf])).toEqual([
    ['DZ5485-612', '10.5', 4, null, '000000000017', false],
    ['FQ1111-400', '9', 2, null, null, false],   // a size picked by hand never takes the barcode
    ['IB4025-100', '3Y', 1, 80, null, false],
    ['ZZ9999-001', '10', 1, null, null, false],
  ]);
  expect(await scope(po.id)).toBe('po');

  // Review: the order manifest card lists every line (editable) with the totals.
  await page.locator('.modal-head .btn.icon').click();
  const card = page.locator('.card.po-box').filter({ hasText: 'Order manifest' });
  await expect(card.locator('.po-box-total')).toContainText('4 SKUs · 8 units · 7 with no price');
  await expect(card.locator('.po-box-total')).toContainText('$80.00');
  await expect(card.getByRole('button', { name: '📷 Scan more into the order manifest' })).toBeVisible();
  expect(await noSideScroll(page)).toBeLessThanOrEqual(0);
});

test('the supplier portal: the whole-order window opens on Paste from the paste button, one tap from the scanner', async ({ page }) => {
  const { po } = await order();
  await portal(page, po);
  await page.getByRole('button', { name: '📋 Paste the whole-order manifest' }).click();
  await expect(page.getByLabel('Paste the list')).toBeVisible();
  await page.getByRole('button', { name: '← Scan instead' }).click();
  const field = page.getByPlaceholder('Scan or type UPC / SKU');
  await field.fill('000000000017'); await field.press('Enter');
  await expect(page.locator('.po-scan-recent')).toContainText('DZ5485-612 · 10.5 · ×1');
});
