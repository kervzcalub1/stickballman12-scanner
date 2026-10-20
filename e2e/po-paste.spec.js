// PO "Paste a list" (src/lib/poPaste.js, api/po/scan-bulk.js): a supplier's
//   DZ5485-201
//   8.5 x 2
//   9 x 3
// message, many shoes at once, onto a label or a whole-order list (supplier or PH).
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import { parsePoPaste } from '../src/lib/poPaste.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const SUPPLIER = 'E2E Paste Supplier';
let SUP; let OTHER;
const tokenFor = (uid, username, role) => signToken({ uid, username, name: username, role });
const hdr = (t) => ({ Authorization: `Bearer ${t}` });
let supTok; let otherTok;
const PH = tokenFor('e2e-paste-ph', 'e2e_paste_ph', 'ph_team');

test.beforeAll(async () => {
  const mk = async (u) => Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$1,'x','supplier','approved')
     ON CONFLICT (username) DO UPDATE SET role='supplier' RETURNING id`, [u]))[0].id);
  SUP = await mk('e2e_paste_sup'); OTHER = await mk('e2e_paste_other');
  supTok = tokenFor(SUP, 'e2e_paste_sup', 'supplier'); otherTok = tokenFor(OTHER, 'e2e_paste_other', 'supplier');
});
test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q(`DELETE FROM users WHERE username IN ('e2e_paste_sup','e2e_paste_other')`);
  await pool.end();
});

async function order({ kind = 'shoes', scope = 'box' } = {}) {
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, raised_by, expected_boxes, status, order_kind, manifest_scope)
     VALUES ($1,$2,'supplier',1,'draft',$3,$4) RETURNING *`, [SUPPLIER, SUP, kind, scope]))[0];
  const [box] = await q(`INSERT INTO po_boxes (po_id, box_number, status) VALUES ($1, 1, 'pending') RETURNING *`, [po.id]);
  return { po, box };
}
const lines = (poId) => q(`SELECT sku, size, qty_expected::int AS qty, unit_cost::float AS cost, po_box_id, entered_on_behalf
                             FROM po_lines WHERE po_id = $1 ORDER BY sku, size`, [poId]);
const bulk = (request, tok, data) => request.post('/api/po/scan-bulk', { headers: hdr(tok), data });

test('the parser: blocks, a price on the SKU line, a spaced SKU, the same SKU twice, and a stray line', () => {
  const r = parsePoPaste('DZ5485-201\n8.5 x 2\n9 x 3\n9.5 x 4\n\nIB4025 100 $120\n10 x 1\n\ndz5485-201\n9x1\nJordan 4 something\n8 x 5');
  expect(r.shoes).toEqual([
    { sku: 'DZ5485-201', name: '', unitCost: null, sizes: [{ size: '8.5', qty: 2 }, { size: '9', qty: 4 }, { size: '9.5', qty: 4 }] },
    { sku: 'IB4025-100', name: '', unitCost: 120, sizes: [{ size: '10', qty: 1 }] },
  ]);
  // The stray line is reported, and the sizes UNDER it are refused, not given to the shoe above.
  expect(r.skipped.map((x) => x.line)).toEqual(['Jordan 4 something', '8 x 5']);
  expect(r.pairs).toBe(11);
});

test('a supplier pastes onto their own label; pasting again tops up; the guards hold', async ({ request }) => {
  const { po, box } = await order();
  const shoes = parsePoPaste('DZ5485-201\n8.5 x 2\n9 x 3\n9.5 x 4\n\nIB4025-100 $120\n10 x 1').shoes;
  const r = await bulk(request, supTok, { poBoxId: box.id, shoes });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await r.json()).pairs).toBe(10);
  expect(await lines(po.id)).toEqual([
    { sku: 'DZ5485-201', size: '8.5', qty: 2, cost: null, po_box_id: box.id, entered_on_behalf: false },
    { sku: 'DZ5485-201', size: '9', qty: 3, cost: null, po_box_id: box.id, entered_on_behalf: false },
    { sku: 'DZ5485-201', size: '9.5', qty: 4, cost: null, po_box_id: box.id, entered_on_behalf: false },
    { sku: 'IB4025-100', size: '10', qty: 1, cost: 120, po_box_id: box.id, entered_on_behalf: false },
  ]);
  // A second paste of the same sizes adds to them — no duplicate rows.
  await bulk(request, supTok, { poBoxId: box.id, shoes: [{ sku: 'DZ5485-201', sizes: [{ size: '9', qty: 2 }] }] });
  expect((await lines(po.id)).find((l) => l.size === '9').qty).toBe(5);
  expect(await lines(po.id)).toHaveLength(4);

  // Someone else's order; a whole-order list on top of a per-box one; a bad quantity — nothing written.
  expect((await bulk(request, otherTok, { poBoxId: box.id, shoes })).status()).toBe(403);
  expect((await bulk(request, supTok, { poId: po.id, shoes })).status()).toBe(409);
  const bad = await bulk(request, supTok, { poBoxId: box.id, shoes: [{ sku: 'X1-100', sizes: [{ size: '9', qty: 1 }] }, { sku: 'Y1-100', sizes: [{ size: '9', qty: 0 }] }] });
  expect(bad.status()).toBe(400);
  expect((await lines(po.id)).some((l) => l.sku === 'X1-100')).toBe(false);
  // A label that has left the supplier is closed to the supplier.
  await q(`UPDATE po_boxes SET status = 'shipped' WHERE id = $1`, [box.id]);
  expect((await bulk(request, supTok, { poBoxId: box.id, shoes })).status()).toBe(409);
});

test('PH pastes on the supplier\'s behalf — onto a label, or as the whole-order list; a boxes order is refused', async ({ request }) => {
  const a = await order();
  expect((await bulk(request, PH, { poBoxId: a.box.id, shoes: [{ sku: 'DZ5485-201', sizes: [{ size: '8', qty: 1 }] }] })).ok()).toBeTruthy();
  expect((await lines(a.po.id))[0]).toMatchObject({ entered_on_behalf: true, po_box_id: a.box.id });

  const b = await order({ scope: 'po' });
  const r = await bulk(request, PH, { poId: b.po.id, shoes: parsePoPaste('DZ5485-201\n8.5 x 2\n9 x 3').shoes });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await lines(b.po.id)).map((l) => [l.size, l.qty, l.po_box_id])).toEqual([['8.5', 2, null], ['9', 3, null]]);
  expect((await q('SELECT manifest_scope FROM purchase_orders WHERE id = $1', [b.po.id]))[0].manifest_scope).toBe('po');

  const c = await order({ kind: 'boxes' });
  expect((await bulk(request, PH, { poBoxId: c.box.id, shoes: [{ sku: 'DZ5485-201', sizes: [{ size: '9', qty: 1 }] }] })).status()).toBe(409);
});

test('a supplier pastes ONE list for the whole order (not split by box); the guards hold', async ({ request }) => {
  const { po, box } = await order();
  const r = await bulk(request, supTok, { poId: po.id, shoes: parsePoPaste('DZ5485-201\n8.5 x 2\n9 x 3\n\nIB4025-100 $120\n10 x 1').shoes });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect(await lines(po.id)).toEqual([
    { sku: 'DZ5485-201', size: '8.5', qty: 2, cost: null, po_box_id: null, entered_on_behalf: false },
    { sku: 'DZ5485-201', size: '9', qty: 3, cost: null, po_box_id: null, entered_on_behalf: false },
    { sku: 'IB4025-100', size: '10', qty: 1, cost: 120, po_box_id: null, entered_on_behalf: false },
  ]);
  expect((await q('SELECT manifest_scope FROM purchase_orders WHERE id = $1', [po.id]))[0].manifest_scope).toBe('po');
  // Now the boxes carry nothing of their own: a label paste is refused, and a box closes empty.
  expect((await bulk(request, supTok, { poBoxId: box.id, shoes: [{ sku: 'DZ5485-201', sizes: [{ size: '8', qty: 1 }] }] })).status()).toBe(409);
  const closed = await request.post('/api/po/close-box', { headers: hdr(supTok), data: { poBoxId: box.id } });
  expect(closed.ok(), await closed.text()).toBeTruthy();

  const one = [{ sku: 'DZ5485-201', sizes: [{ size: '8', qty: 1 }] }];
  // Someone else's order.
  expect((await bulk(request, otherTok, { poId: po.id, shoes: one })).status()).toBe(403);
  // A buying-request order: the order-level list is OUR receipt — theirs is per label.
  const receipt = await order({ scope: 'order+box' });
  expect((await bulk(request, supTok, { poId: receipt.po.id, shoes: one })).status()).toBe(409);
  // Once every label has shipped, it's PH's to correct.
  const gone = await order();
  await q(`UPDATE purchase_orders SET status = 'receiving' WHERE id = $1`, [gone.po.id]);
  expect((await bulk(request, supTok, { poId: gone.po.id, shoes: one })).status()).toBe(409);
  expect(await lines(gone.po.id)).toHaveLength(0);
});

test('the supplier portal: Paste the whole-order manifest → the box closes with nothing listed on it', async ({ page }) => {
  const { po } = await order();
  await page.addInitScript(([t, u]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u); },
    [supTok, JSON.stringify({ username: 'e2e_paste_sup', name: SUPPLIER, role: 'supplier' })]);
  await page.route('**/api/sku-search**', (route) => route.fulfill({ json: { ok: true, product: { name: 'Air Jordan 1 Low Test', sku: 'DZ5485-201', sizes: [] } } }));
  await page.goto('/orders');
  await page.locator('.po-card').filter({ hasText: po.po_code }).first().click();
  await page.getByRole('button', { name: '📋 Paste the whole-order manifest' }).click();
  // Straight into the paste box — no scanner toggle on the whole-order list.
  await expect(page.getByRole('button', { name: '📋 Paste a list' })).toHaveCount(0);
  await page.getByLabel('Paste the list').fill('DZ5485-201\n8.5 x 2\n9 x 3');
  await page.getByRole('button', { name: 'Add 5 pairs (1 SKU) to order' }).click();
  await expect(page.getByRole('status')).toContainText('Added 5 pairs · 1 SKU to the whole order');
  await page.locator('.modal-head .btn.icon').click();
  expect((await lines(po.id)).map((l) => [l.size, l.qty, l.po_box_id])).toEqual([['8.5', 2, null], ['9', 3, null]]);
  // The label no longer takes items of its own, and closes with nothing listed on it.
  await expect(page.getByRole('button', { name: /^Add items$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review & close box' }).click();
  await expect(page.getByRole('dialog')).toContainText('one manifest for the whole order');
  await page.getByRole('button', { name: 'Close box for shipment' }).click();
  await expect(page.getByRole('dialog')).toContainText('is closed');
});

test('the supplier portal: Paste a list → preview → Add', async ({ page }) => {
  const { po } = await order();
  await page.addInitScript(([t, u]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u); },
    [supTok, JSON.stringify({ username: 'e2e_paste_sup', name: SUPPLIER, role: 'supplier' })]);
  await page.route('**/api/sku-search**', (route) => route.fulfill({ json: { ok: true, product: { name: 'Air Jordan 1 Low Test', sku: 'DZ5485-201', sizes: [] } } }));
  await page.goto('/orders');
  await page.locator('.po-card').filter({ hasText: po.po_code }).first().click();
  await page.getByRole('button', { name: /^Add items$/ }).first().click();
  await page.getByRole('button', { name: '📋 Paste a list' }).click();
  await page.getByLabel('Paste the list').fill('DZ5485-201\n8.5 x 2\n9 x 3\n9.5 x 4\noops\n10 x 9');
  await expect(page.locator('.po-paste-list li')).toHaveCount(1);
  await expect(page.locator('.po-paste-list')).toContainText('Air Jordan 1 Low Test');
  await expect(page.locator('.po-paste-skipped')).toContainText('oops');
  await page.locator('.po-paste-price input').fill('95');
  await page.getByRole('button', { name: 'Add 9 pairs (1 SKU) to label' }).click();
  await expect(page.getByRole('status')).toContainText('Added 9 pairs · 1 SKU to Label 1');
  expect((await lines(po.id)).map((l) => [l.size, l.qty, l.cost])).toEqual([['8.5', 2, 95], ['9', 3, 95], ['9.5', 4, 95]]);
});
