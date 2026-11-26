// Buy Log (2026-11-26, docs/context/buy-log.md): a supplier's own record of what they bought
// for us from a store that gives no receipt — SKU, pairs, cost (a size when known), the
// payments made against it, and the purchase orders it ships on. What has to hold:
//   · switched on per supplier (`log_buys`); a supplier sees only their own orders;
//   · the supplier declares, STAFF record payments — the supplier cannot sign for money;
//   · unpaid → partly paid → paid from the payment rows; a blank size is "not known";
//   · ordered vs shipped (the linked PO's manifest) vs received (pairs scanned on its batch),
//     by SKU, and by size only where every line of the SKU has one.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loadEnv } from './helpers/auth.js';
import { signToken, hashPassword } from '../api/_lib/util.js';
import { buyCompare, buyMoney, sizeKey } from '../src/lib/buyLog.js';

loadEnv();
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const stamp = `${Date.now()}`.slice(-7);
const SKU = `E2E-BL-${stamp}`;
const people = {};
let poId; let batchId; let buyId;
const tok = (u) => ({ Authorization: `Bearer ${signToken({ uid: u.uid, username: u.username, name: u.name, role: u.role })}` });
const PH = { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` };
const BASE = (() => { const b = String(process.env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''); return b ? (b.includes('://') ? b : `https://${b}`) : ''; })();
const WH = { Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}` };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await db.connect();
  for (const [k, u] of Object.entries({
    joey: { username: `e2e_bl_joey_${stamp}`, name: `E2E BL Joey ${stamp}`, role: 'supplier', privileges: ['log_buys'] },
    other: { username: `e2e_bl_other_${stamp}`, name: `E2E BL Other ${stamp}`, role: 'supplier', privileges: ['log_buys'] },
    plain: { username: `e2e_bl_plain_${stamp}`, name: `E2E BL Plain ${stamp}`, role: 'supplier', privileges: [] },
  })) {
    const { rows } = await db.query(`INSERT INTO users (name, username, pass_hash, role, status, privileges) VALUES ($1,$2,$3,$4,'approved',$5) RETURNING id`,
      [u.name, u.username, hashPassword('e2e-not-used'), u.role, u.privileges]);
    people[k] = { ...u, uid: Number(rows[0].id) };
  }
  // Joey's purchase order: 3 pairs of size 10 and 2 of size 11 on its box list; the warehouse
  // has scanned in 2 of the 10s and 1 of the 11s on its batch.
  poId = Number((await db.query(`INSERT INTO purchase_orders (po_code, supplier_name, supplier_user_id, status) VALUES ($1,$2,$3,'receiving') RETURNING id`,
    [`PO-E2EBL-${stamp}`, people.joey.name, people.joey.uid])).rows[0].id);
  const box = (await db.query(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'shipped') RETURNING id`, [poId, `BL${stamp}`])).rows[0].id;
  await db.query(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected) VALUES ($1,$2,$3,'10','E2E BL Shoe',3), ($1,$2,$3,'11','E2E BL Shoe',2)`, [poId, box, SKU]);
  batchId = Number((await db.query(`INSERT INTO batches (batch_code, supplier_name, status, kind, po_id) VALUES ($1,$2,'committed','receiving',$3) RETURNING id`,
    [`B-E2EBL-${stamp}`, people.joey.name, poId])).rows[0].id);
  await db.query(`INSERT INTO items (vin, batch_id, name, sku, size, status) VALUES ($1,$4,'E2E BL Shoe',$5,'10','needs_shelf'), ($2,$4,'E2E BL Shoe',$5,'10','needs_shelf'), ($3,$4,'E2E BL Shoe',$5,'11','needs_shelf')`,
    [`E2EBL-${stamp}-1`, `E2EBL-${stamp}-2`, `E2EBL-${stamp}-3`, batchId, SKU]);
});

test.afterAll(async () => {
  await db.query('DELETE FROM buy_logs WHERE supplier_user_id = ANY($1)', [Object.values(people).map((p) => p.uid)]);
  await db.query('DELETE FROM items WHERE batch_id = $1', [batchId]);
  await db.query('DELETE FROM batches WHERE id = $1', [batchId]);
  await db.query('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(people).map((p) => p.uid)]);
  await db.end();
});

test('the maths: payment state, and ordered vs shipped vs received by SKU and by size', () => {
  expect(buyMoney([{ qty: 5, unit_cost: 60 }], [])).toMatchObject({ pairs: 5, total: 300, paid: 0, balance: 300, state: 'unpaid' });
  expect(buyMoney([{ qty: 5, unit_cost: 60 }], [{ amount: 100 }]).state).toBe('part');
  expect(buyMoney([{ qty: 5, unit_cost: 60 }], [{ amount: 100 }, { amount: 200 }]).state).toBe('paid');
  expect(buyMoney([{ qty: 5, unit_cost: 60 }], [{ amount: 350 }])).toMatchObject({ balance: -50, state: 'over' });
  expect([sizeKey('10W'), sizeKey(' 10 '), sizeKey(''), sizeKey('any'), sizeKey('?')]).toEqual(['10', '10', '', '', '']);

  // No size declared: the SKU's pair count is all that is checked.
  const loose = buyCompare([{ sku: 'AB1234-100', qty: 5, unit_cost: 60 }], [{ sku: 'AB1234-100', size: '10', qty: 5 }], [{ sku: 'ab1234 100', size: '10', qty: 3 }]);
  expect(loose.rows).toEqual([{ sku: 'AB1234-100', name: null, ordered: 5, shipped: 5, received: 3, extra: false, short: 2, sizes: null }]);
  expect(loose.state).toBe('part');
  // Sizes declared on every line: a right total in the wrong sizes is NOT "received".
  const sized = buyCompare([{ sku: 'X1', size: '10', qty: 1 }, { sku: 'X1', size: '11', qty: 1 }], [], [{ sku: 'X1', size: '10', qty: 2 }]);
  expect(sized.rows[0].sizes).toEqual([{ size: '10', ordered: 1, shipped: 0, received: 2 }, { size: '11', ordered: 1, shipped: 0, received: 0 }]);
  expect(sized.state).toBe('part');
  // Something on the PO that is not on the order is shown apart, and does not count.
  const extra = buyCompare([{ sku: 'X1', qty: 1 }], [], [{ sku: 'X1', size: '9', qty: 1 }, { sku: 'ZZ9', size: '9', qty: 4 }]);
  expect(extra.rows.map((r) => [r.sku, r.extra])).toEqual([['X1', false], ['ZZ9', true]]);
  expect(extra.state).toBe('received');
  expect(buyCompare([{ sku: 'X1', qty: 1 }], [], [], { linked: false }).state).toBe('no_po');
  expect(buyCompare([{ sku: 'X1', qty: 1 }], [{ sku: 'X1', size: '9', qty: 1 }], []).state).toBe('shipped');
  expect(buyCompare([{ sku: 'X1', qty: 1 }], [], [{ sku: 'X1', size: '9', qty: 2 }]).state).toBe('over');
});

test('who may: switched on per supplier, own orders only, and only staff record payments', async ({ request }) => {
  // Not switched on → 403 everywhere; the warehouse reads but cannot write.
  expect((await request.get('/api/buy-log/list', { headers: tok(people.plain) })).status()).toBe(403);
  expect((await request.post('/api/buy-log/save', { headers: tok(people.plain), data: {} })).status()).toBe(403);
  expect((await request.get('/api/buy-log/list', { headers: WH })).status()).toBe(200);
  expect((await request.post('/api/buy-log/save', { headers: WH, data: { lines: [{ sku: SKU, qty: 1, unit_cost: 1 }] } })).status()).toBe(403);

  // Bad input is a 400 with a reason, never a 500.
  const bad = async (data) => { const r = await request.post('/api/buy-log/save', { headers: tok(people.joey), data }); return [r.status(), (await r.json()).error]; };
  expect((await bad({ lines: [] }))[0]).toBe(400);
  expect(await bad({ lines: [{ sku: SKU, qty: 0, unit_cost: 60 }] })).toEqual([400, expect.stringMatching(/pairs/i)]);
  expect(await bad({ lines: [{ sku: SKU, qty: 2, unit_cost: '' }] })).toEqual([400, expect.stringMatching(/cost per pair/i)]);
  expect(await bad({ ordered_on: '2026-02-30', lines: [{ sku: SKU, qty: 2, unit_cost: 60 }] })).toEqual([400, expect.stringMatching(/real date/i)]);

  // Joey declares: 4 pairs with no size, at $60. Sizes are optional.
  const save = await request.post('/api/buy-log/save', { headers: tok(people.joey),
    data: { store: 'Nike Store E2E', order_number: `N-${stamp}`, ordered_on: '2026-11-20', tracking_numbers: `1ze2ebl${stamp}00, short`, note: 'paid up front',
      lines: [{ sku: SKU.toLowerCase(), qty: 4, unit_cost: 60 }] } });
  expect(save.ok(), await save.text()).toBeTruthy();
  buyId = (await save.json()).id;

  const mine = (await (await request.get('/api/buy-log/list', { headers: tok(people.joey) })).json());
  expect(mine.can).toEqual({ edit: true, pay: true, unpay: false, proofNeeded: true, all: false });
  expect(mine.buys).toHaveLength(1);
  expect(mine.buys[0]).toMatchObject({ code: `BL-${buyId}`, supplier_name: people.joey.name, store: 'Nike Store E2E', ordered_on: '2026-11-20',
    tracking_numbers: [`1ZE2EBL${stamp}00`], receiving: 'no_po', money: { pairs: 4, total: 240, paid: 0, balance: 240, state: 'unpaid' } });
  expect(mine.buys[0].lines[0]).toMatchObject({ sku: SKU, size: '', qty: 4, unit_cost: 60, entered_by: people.joey.name });

  // Another supplier sees none of it and cannot touch it.
  expect((await (await request.get('/api/buy-log/list', { headers: tok(people.other) })).json()).buys).toHaveLength(0);
  expect((await request.get(`/api/buy-log/list?id=${buyId}`, { headers: tok(people.other) })).status()).toBe(404);
  expect((await request.post('/api/buy-log/action', { headers: tok(people.other), data: { action: 'delete', id: buyId } })).status()).toBe(404);
  expect((await request.post('/api/buy-log/save', { headers: tok(people.other), data: { id: buyId, lines: [{ sku: SKU, qty: 1, unit_cost: 1 }] } })).status()).toBe(404);

  // The supplier records a payment they sent ONLY with its screenshot — and a screenshot is a
  // file this order's own upload path produced, not any URL (nor another order's).
  const pay = (data) => request.post('/api/buy-log/action', { headers: tok(people.joey), data: { action: 'pay', id: buyId, paid_on: '2026-11-19', amount: 10, ...data } });
  const none = await pay({});
  expect([none.status(), (await none.json()).error]).toEqual([400, expect.stringMatching(/screenshot/i)]);
  expect((await pay({ proof: ['https://evil.example/x.png', `${BASE}/buy-log/order-999999/x.png`] })).status()).toBe(400);
  expect((await request.post('/api/buy-log/proof-sign', { headers: tok(people.other), data: { id: buyId, contentType: 'image/png' } })).status()).toBe(404);
  test.skip(!BASE, 'R2_PUBLIC_BASE_URL is not set here');
  const shot = `${BASE}/buy-log/order-${buyId}/e2e-${stamp}.png`;
  const ok = await pay({ proof: [shot, shot], method: 'Zelle' });
  expect(ok.ok(), await ok.text()).toBeTruthy();
  const after = (await (await request.get(`/api/buy-log/list?id=${buyId}`, { headers: tok(people.joey) })).json()).buy;
  expect(after.payments).toHaveLength(1);
  expect(after.payments[0]).toMatchObject({ amount: 10, proof: [shot], paid_by: people.joey.name, created_by: people.joey.name });
  // More screenshots later; only staff remove a payment.
  const pid = after.payments[0].id;
  const act = (headers, data) => request.post('/api/buy-log/action', { headers, data: { id: buyId, payment_id: pid, ...data } });
  expect((await act(tok(people.joey), { action: 'proof', proof: [`${BASE}/buy-log/order-${buyId}/e2e-${stamp}-2.png`] })).ok()).toBeTruthy();
  expect((await act(tok(people.joey), { action: 'proof', proof: [] })).status()).toBe(400);
  expect((await act(tok(people.joey), { action: 'unpay' })).status()).toBe(403);
  expect((await act(PH, { action: 'unpay' })).ok()).toBeTruthy();
});

test('staff record payments; the order links to its PO and is compared with what was received', async ({ request }) => {
  const act = (headers, data) => request.post('/api/buy-log/action', { headers, data: { id: buyId, ...data } });
  expect((await act(PH, { action: 'pay', paid_on: '2026-11-20', amount: 0 })).status()).toBe(400);
  expect((await act(PH, { action: 'pay', paid_on: '2026-11-20', amount: 100, method: 'Zelle', paid_by: 'Alex', note: 'ref 1' })).ok()).toBeTruthy();
  let one = (await (await request.get(`/api/buy-log/list?id=${buyId}`, { headers: PH })).json());
  expect(one.buy.money).toMatchObject({ paid: 100, balance: 140, state: 'part' });
  expect(one.buy.payments[0]).toMatchObject({ paid_on: '2026-11-20', amount: 100, method: 'Zelle', paid_by: 'Alex', created_by: 'E2E PH' });
  expect((await act(PH, { action: 'pay', paid_on: '2026-11-21', amount: 140 })).ok()).toBeTruthy();

  // Only the supplier's own POs can be linked — the link decides what counts as received.
  expect(one.pos.map((o) => o.po_id)).toContain(poId);
  expect((await act(tok(people.joey), { action: 'link', po_id: 999999999 })).status()).toBe(400);
  expect((await act(tok(people.joey), { action: 'link', po_id: poId })).ok()).toBeTruthy();
  one = (await (await request.get(`/api/buy-log/list?id=${buyId}`, { headers: tok(people.joey) })).json());
  expect(one.buy.money.state).toBe('paid');
  expect(one.buy.pos.map((o) => o.po_code)).toEqual([`PO-E2EBL-${stamp}`]);
  // Ordered 4 (no sizes) · the PO's box list says 5 · 3 scanned in → partly received, 1 to come.
  expect(one.buy.compare).toEqual([{ sku: SKU, name: 'E2E BL Shoe', ordered: 4, shipped: 5, received: 3, extra: false, short: 1, sizes: null }]);
  expect(one.buy.receiving).toBe('part');
  expect(one.buy.counts).toEqual({ ordered: 4, shipped: 5, received: 3 });

  // PH corrects the order to sizes: who changed a line is on the line; the comparison goes by size.
  const fix = await request.post('/api/buy-log/save', { headers: PH, data: { id: buyId, store: 'Nike Store E2E', ordered_on: '2026-11-20',
    lines: [{ id: one.buy.lines[0].id, sku: SKU, size: '10', qty: 2, unit_cost: 60 }, { sku: SKU, size: '11', qty: 2, unit_cost: 60 }] } });
  expect(fix.ok(), await fix.text()).toBeTruthy();
  one = (await (await request.get(`/api/buy-log/list?id=${buyId}`, { headers: PH })).json());
  expect(one.buy.lines.map((l) => [l.size, l.qty, l.entered_by])).toEqual([['10', 2, 'E2E PH'], ['11', 2, 'E2E PH']]);
  expect(one.buy.compare[0].sizes).toEqual([{ size: '10', ordered: 2, shipped: 3, received: 2 }, { size: '11', ordered: 2, shipped: 2, received: 1 }]);

  // A supplier cannot delete an order that has money or a PO on it; PH can.
  expect((await act(tok(people.joey), { action: 'delete' })).status()).toBe(409);
  expect((await act(PH, { action: 'unpay', payment_id: one.buy.payments[0].id })).ok()).toBeTruthy();
  expect((await act(PH, { action: 'unlink', po_id: poId })).ok()).toBeTruthy();
  expect((await act(PH, { action: 'link', po_id: poId })).ok()).toBeTruthy();
});

test('the pages: PH sees every supplier’s order with its chips; the supplier gets the card only when switched on', async ({ page }) => {
  await page.addInitScript(([t, u]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u); },
    [signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' }), JSON.stringify({ username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })]);
  await page.goto(`/ph/buy-log?q=${SKU}`);
  const row = page.locator('.bl-row').filter({ hasText: `BL-${buyId}` });
  await expect(row).toContainText(people.joey.name);
  await expect(row).toContainText('Partly paid');
  await expect(row).toContainText('Partly received');
  await expect(page.getByRole('button', { name: '⬇ Excel' })).toBeEnabled();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`id=${buyId}`));
  await expect(page.getByRole('heading', { name: new RegExp(`BL-${buyId}`) })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record payment' })).toBeVisible();
  await expect(page.getByText('10: 2 → 2')).toBeVisible();
  await expect(page.getByText('11: 2 → 1')).toBeVisible();
  // A refresh stays on the open order; nothing scrolls sideways on a phone.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await expect(page.getByRole('heading', { name: new RegExp(`BL-${buyId}`) })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('the supplier’s portal: the card and the page only with the privilege, and no payment form', async ({ browser }) => {
  const as = async (u) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(([t, j]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', j); },
      [signToken({ uid: u.uid, username: u.username, name: u.name, role: u.role }), JSON.stringify({ username: u.username, name: u.name, role: u.role, privileges: u.privileges })]);
    return { ctx, page };
  };
  const plain = await as(people.plain);
  await plain.page.goto('/buy-log');
  await expect(plain.page.getByText('Purchase Orders').first()).toBeVisible();
  await expect(plain.page.getByText('Buy Log')).toHaveCount(0);
  await plain.ctx.close();

  const joey = await as(people.joey);
  await joey.page.goto('/');
  await joey.page.getByRole('button', { name: /Buy Log/ }).click();
  await expect(joey.page).toHaveURL(/\/buy-log/);
  await joey.page.locator('.bl-row').filter({ hasText: `BL-${buyId}` }).click();
  // The supplier may record a payment they sent — but not without its screenshot.
  await joey.page.getByLabel('Amount paid').fill('25');
  await expect(joey.page.getByText('Add the screenshot to record the payment.')).toBeVisible();
  await expect(joey.page.getByRole('button', { name: 'Record payment' })).toBeDisabled();
  await expect(joey.page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  if (process.env.BL_SHOTS) { await joey.page.setViewportSize({ width: 1300, height: 1500 }); await joey.page.screenshot({ path: `${process.env.BL_SHOTS}/supplier-order.png`, fullPage: true }); }
  // A new order. The product lookup is the app's own (sku-search / upc-search) — stubbed here,
  // so no marketplace is called: a typed SKU brings its name, a scanned box barcode brings
  // the SKU, the name AND the size, one pair a scan.
  await joey.page.route('**/api/sku-search', async (route) => {
    const sku = String(route.request().postDataJSON().sku || '').toUpperCase();
    return sku.includes('NOPE') ? route.fulfill({ status: 404, json: { ok: false, error: 'No product found.' } })
      : route.fulfill({ json: { ok: true, product: { sku, name: `E2E Shoe ${sku}` } } });
  });
  await joey.page.route('**/api/upc-search', (route) => route.fulfill({ json: { ok: true, product: { sku: `${SKU}-U`, name: 'E2E Scanned Shoe', scannedSize: '9.5' } } }));
  await joey.page.getByRole('button', { name: '← All orders' }).click();
  await joey.page.getByRole('button', { name: '＋ New order' }).click();
  // There is no tracking field: the tracking numbers are the linked PO's labels.
  await expect(joey.page.getByLabel('Tracking numbers')).toHaveCount(0);
  const scan = joey.page.getByLabel('Scan or type a UPC or SKU');
  await scan.fill(`${SKU}-n`); await scan.press('Enter');
  await expect(joey.page.getByLabel('SKU, line 1')).toHaveValue(`${SKU}-N`);
  await expect(joey.page.getByLabel('Shoe name, line 1')).toHaveValue(`E2E Shoe ${SKU}-N`);
  await scan.fill('196149780863'); await scan.press('Enter');
  await scan.fill('196149780863'); await scan.press('Enter');
  await expect(joey.page.getByLabel('SKU, line 2')).toHaveValue(`${SKU}-U`);
  await expect(joey.page.getByLabel('Size, line 2')).toHaveValue('9.5');
  await expect(joey.page.getByLabel('Pairs, line 2')).toHaveValue('2');
  await expect(joey.page.getByText('E2E Scanned Shoe · +1 pair')).toBeVisible();
  // Not found says so, and adds nothing.
  await scan.fill('NOPE-123'); await scan.press('Enter');
  await expect(joey.page.getByText(/No shoe found for “NOPE-123”/)).toBeVisible();
  await expect(joey.page.getByLabel('SKU, line 3')).toHaveCount(0);
  // Typed straight into the table: leaving the SKU box fills the name.
  await joey.page.getByRole('button', { name: '＋ Add a shoe' }).click();
  await joey.page.getByLabel('SKU, line 3').fill(`${SKU}-T`);
  await joey.page.getByLabel('Pairs, line 3').fill('1');
  await expect(joey.page.getByLabel('Shoe name, line 3')).toHaveValue(`E2E Shoe ${SKU}-T`);
  await joey.page.getByLabel('Cost per pair, line 3').fill('10');
  await joey.page.getByLabel('Cost per pair, line 2').fill('20');
  await joey.page.getByLabel('Pairs, line 1').fill('6');
  await joey.page.getByLabel('Cost per pair, line 1').fill('55');
  await expect(joey.page.getByText('$380.00').first()).toBeVisible();
  if (process.env.BL_SHOTS) { await joey.page.setViewportSize({ width: 1300, height: 1100 }); await joey.page.screenshot({ path: `${process.env.BL_SHOTS}/new-order.png`, fullPage: true }); }
  await joey.page.getByRole('button', { name: 'Save the order' }).click();
  await expect(joey.page.getByText('No payment recorded yet.')).toBeVisible();
  await expect(joey.page).toHaveURL(/id=\d+/);
  await joey.ctx.close();
});
