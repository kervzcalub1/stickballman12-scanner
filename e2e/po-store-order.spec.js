// Store orders (docs/store-orders-plan.md): one supplier buying from many stores, each store
// shipping its own boxes. The list is pasted store by store (api/po/store-list.js), managed
// with api/po/store.js, and boxes are added under the store that ships them.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import { parseStorePaste } from '../src/lib/storePaste.js';
import { PO_SUPPLIER_HIDDEN_KEYS, STORE_SUPPLIER_HIDDEN_KEYS } from '../api/_lib/po-supplier-view.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const SUPPLIER = 'E2E Store Supplier';
const tokenFor = (uid, username, role) => signToken({ uid, username, name: username, role });
const hdr = (t) => ({ Authorization: `Bearer ${t}` });
const PH = tokenFor('e2e-store-ph', 'e2e_store_ph', 'ph_team');
let SUP; let OTHER; let supTok; let otherTok;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const mk = async (u) => Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$1,'x','supplier','approved')
     ON CONFLICT (username) DO UPDATE SET role='supplier', name=$1 RETURNING id`, [u]))[0].id);
  SUP = await mk('e2e_store_sup'); OTHER = await mk('e2e_store_other');
  // A supplier's order carries their business name, which create.js reads off the token.
  supTok = signToken({ uid: SUP, username: 'e2e_store_sup', name: SUPPLIER, role: 'supplier' });
  otherTok = tokenFor(OTHER, 'e2e_store_other', 'supplier');
});
test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q(`DELETE FROM users WHERE username IN ('e2e_store_sup','e2e_store_other')`);
  await pool.end();
});

const create = async (request) => {
  const r = await request.post('/api/po/create', { headers: hdr(supTok), data: { byStore: true, tagCode: 'e2e store' } });
  expect(r.status()).toBe(200);
  return (await r.json()).po;
};
const storeList = (request, tok, poId, text) => request.post('/api/po/store-list', {
  headers: hdr(tok),
  data: { poId, stores: parseStorePaste(text).stores.map((s) => ({ name: s.name, shoes: s.shoes })) },
});
const act = (request, tok, poId, action, extra = {}) => request.post('/api/po/store', { headers: hdr(tok), data: { poId, action, ...extra } });
const linesOf = (poId) => q(`SELECT s.name AS store, l.sku, l.size, l.qty_expected::int AS qty, l.unit_cost::float AS cost
                               FROM po_lines l JOIN po_stores s ON s.id = l.po_store_id WHERE l.po_id = $1
                              ORDER BY s.position, l.sku, l.size`, [poId]);

const TWO_STORES = 'Store: AF #1234 Dallas\nDZ5485-612 $110\n8 x2\n10 x1\nStore: AF #2210 New Orleans\nDZ5485-612 $110\n10 x4';

test('the parser keeps stores apart: the same shoe in two stores at two prices stays two', () => {
  const r = parseStorePaste('Store: A\nDZ5485-612 $110\n10 x2\nStore #22\nDZ5485-612 $120\n10 x1\nStore Exclusive Dunk\nIB4025-100\n9 x1');
  expect(r.stores.map((s) => [s.name, s.shoes[0].unitCost, s.pairs])).toEqual([['A', 110, 2], ['#22', 120, 2]]);
  // "Store Exclusive Dunk" is not a store line — it stays in #22's block (and is reported),
  // so the unpriced IB4025-100 under it is #22's, and is flagged rather than priced at $0.
  expect(r.skipped.some((k) => k.line === 'Store Exclusive Dunk' && k.store === '#22')).toBe(true);
  expect(r.unpriced).toEqual([{ store: '#22', sku: 'IB4025-100' }]);
  expect(r.total).toBe(340);
});

test('a supplier opens a store order with no boxes; it is a whole-order list from the start', async ({ request }) => {
  const po = await create(request);
  const [row] = await q('SELECT by_store, manifest_scope, (SELECT count(*) FROM po_boxes WHERE po_id = $1)::int AS boxes FROM purchase_orders WHERE id = $1', [po.id]);
  expect(row).toEqual({ by_store: true, manifest_scope: 'po', boxes: 0 });
  // A store order can't also be opened with boxes, or be for empty shoe boxes.
  const bad = await request.post('/api/po/create', { headers: hdr(supTok), data: { byStore: true, boxes: 3 } });
  expect(bad.status()).toBe(400);
});

test('the same shoe and size from two stores is two lines; re-pasting adds; a different price is refused', async ({ request }) => {
  const po = await create(request);
  expect((await storeList(request, supTok, po.id, TWO_STORES)).status()).toBe(200);
  expect(await linesOf(po.id)).toEqual([
    { store: 'AF #1234 Dallas', sku: 'DZ5485-612', size: '10', qty: 1, cost: 110 },
    { store: 'AF #1234 Dallas', sku: 'DZ5485-612', size: '8', qty: 2, cost: 110 },
    { store: 'AF #2210 New Orleans', sku: 'DZ5485-612', size: '10', qty: 4, cost: 110 },
  ]);
  // Same store spelled differently (case / spaces) is the same store; the qty adds up.
  expect((await storeList(request, supTok, po.id, 'Store: af  #1234 dallas\nDZ5485-612 $110\n10 x2')).status()).toBe(200);
  expect((await linesOf(po.id)).find((l) => l.store === 'AF #1234 Dallas' && l.size === '10').qty).toBe(3);
  // A different price for a line already on the list: refused, nothing re-priced.
  const diff = await storeList(request, supTok, po.id, 'Store: AF #1234 Dallas\nDZ5485-612 $120\n10 x1');
  expect(diff.status()).toBe(409);
  expect((await diff.json()).error).toMatch(/\$110\.00/);
  expect((await linesOf(po.id)).every((l) => l.cost === 110)).toBe(true);
});

test('every shoe needs its price; nothing is written when one is missing', async ({ request }) => {
  const po = await create(request);
  const r = await request.post('/api/po/store-list', { headers: hdr(supTok), data: { poId: po.id, stores: [
    { name: 'A', shoes: [{ sku: 'DZ5485-612', unitCost: 110, sizes: [{ size: '9', qty: 1 }] }] },
    { name: 'B', shoes: [{ sku: 'IB4025-100', sizes: [{ size: '9', qty: 1 }] }] },
  ] } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/no price/);
  expect(await linesOf(po.id)).toEqual([]);
});

test('other writers refuse a store order; another supplier is shut out', async ({ request }) => {
  const po = await create(request);
  await storeList(request, supTok, po.id, TWO_STORES);
  const bulk = await request.post('/api/po/scan-bulk', { headers: hdr(supTok),
    data: { poId: po.id, shoes: [{ sku: 'DZ5485-612', unitCost: 110, sizes: [{ size: '9', qty: 1 }] }] } });
  expect(bulk.status()).toBe(409);
  const one = await request.post('/api/po/scan-order', { headers: hdr(PH), data: { poId: po.id, sku: 'DZ5485-612', size: '9', qty: 1 } });
  expect(one.status()).toBe(409);
  expect((await storeList(request, otherTok, po.id, TWO_STORES)).status()).toBe(403);
  expect((await act(request, otherTok, po.id, 'confirm')).status()).toBe(403);
  // Supplier can't use the staff-only actions.
  expect((await act(request, supTok, po.id, 'unlock', { note: 'x' })).status()).toBe(403);
});

test('boxes go under a store; labels need every box to have one; a store order may drop to no boxes', async ({ request }) => {
  const po = await create(request);
  await storeList(request, supTok, po.id, TWO_STORES);
  const stores = await q('SELECT id, name FROM po_stores WHERE po_id = $1 ORDER BY position', [po.id]);
  // No store → refused.
  expect((await request.post('/api/po/label-add', { headers: hdr(supTok), data: { poId: po.id, boxes: 1 } })).status()).toBe(400);
  const add = await request.post('/api/po/label-add', { headers: hdr(supTok), data: { poId: po.id, boxes: 2, poStoreId: stores[0].id } });
  expect(add.status()).toBe(200);
  // Only store A has boxes; asking for labels is fine (every box has a store).
  expect((await request.post('/api/po/request-labels', { headers: hdr(supTok), data: { poId: po.id } })).status()).toBe(200);
  await request.post('/api/po/request-labels', { headers: hdr(supTok), data: { poId: po.id, requested: false } });
  // A box without a store (written behind the API's back) blocks the request.
  await q(`INSERT INTO po_boxes (po_id, box_number, status) VALUES ($1, 9, 'pending')`, [po.id]);
  const r = await request.post('/api/po/request-labels', { headers: hdr(supTok), data: { poId: po.id } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/store/);
  await q('DELETE FROM po_boxes WHERE po_id = $1 AND box_number = 9', [po.id]);
  // Removing the boxes down to none is allowed on a store order.
  for (const b of await q('SELECT id, box_number FROM po_boxes WHERE po_id = $1', [po.id])) {
    const rm = await request.post('/api/po/label-remove', { headers: hdr(supTok), data: { boxId: b.id, confirm: String(b.box_number) } });
    expect(rm.status()).toBe(200);
  }
  // A store with boxes can't be removed; one without can.
  await request.post('/api/po/label-add', { headers: hdr(supTok), data: { poId: po.id, boxes: 1, poStoreId: stores[0].id } });
  expect((await act(request, supTok, po.id, 'remove', { storeId: stores[0].id })).status()).toBe(409);
  expect((await act(request, supTok, po.id, 'remove', { storeId: stores[1].id })).status()).toBe(200);
});

test('confirm locks the list for the supplier; staff edits are recorded; unlock reopens it', async ({ request }) => {
  const po = await create(request);
  await storeList(request, supTok, po.id, TWO_STORES);
  expect((await act(request, supTok, po.id, 'confirm')).status()).toBe(200);
  // Every supplier writer is now closed.
  expect((await storeList(request, supTok, po.id, 'Store: C\nDZ5485-612 $110\n9 x1')).status()).toBe(409);
  const [line] = await q('SELECT id FROM po_lines WHERE po_id = $1 ORDER BY id LIMIT 1', [po.id]);
  expect((await request.post('/api/po/line', { headers: hdr(supTok), data: { lineId: line.id, qty: 5 } })).status()).toBe(409);
  const stores = await q('SELECT id FROM po_stores WHERE po_id = $1 ORDER BY position', [po.id]);
  expect((await act(request, supTok, po.id, 'rename', { storeId: stores[0].id, name: 'X' })).status()).toBe(409);
  // Staff can still correct it — and the correction goes on the order's history.
  expect((await request.post('/api/po/line', { headers: hdr(PH), data: { lineId: line.id, qty: 5 } })).status()).toBe(200);
  const notes = await q(`SELECT body FROM po_comments WHERE po_id = $1 AND kind = 'system' ORDER BY id`, [po.id]);
  expect(notes.some((n) => /changed a confirmed store-list line: .* → .*×5/.test(n.body))).toBe(true);
  // Staff mark it checked, then reopen it (with a reason) — reopening clears "checked".
  expect((await act(request, PH, po.id, 'invoice_checked', { checked: true })).status()).toBe(200);
  expect((await act(request, PH, po.id, 'unlock', {})).status()).toBe(400);
  expect((await act(request, PH, po.id, 'unlock', { note: 'store 2 recounted' })).status()).toBe(200);
  const [row] = await q('SELECT list_confirmed_at, invoice_checked_at FROM purchase_orders WHERE id = $1', [po.id]);
  expect(row).toEqual({ list_confirmed_at: null, invoice_checked_at: null });
  expect((await storeList(request, supTok, po.id, 'Store: C\nDZ5485-612 $110\n9 x1')).status()).toBe(200);
});

test('an audited order is frozen for everyone', async ({ request }) => {
  const po = await create(request);
  await storeList(request, supTok, po.id, TWO_STORES);
  await q(`UPDATE purchase_orders SET audited_at = now(), audited_by = 'e2e' WHERE id = $1`, [po.id]);
  expect((await storeList(request, PH, po.id, 'Store: C\nDZ5485-612 $110\n9 x1')).status()).toBe(409);
  const [line] = await q('SELECT id FROM po_lines WHERE po_id = $1 LIMIT 1', [po.id]);
  expect((await request.post('/api/po/line', { headers: hdr(PH), data: { lineId: line.id, qty: 5 } })).status()).toBe(409);
});

test('a single list entered before the order was by store can be put under a store (staff)', async ({ request }) => {
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, raised_by, expected_boxes, status, manifest_scope)
     VALUES ($1,$2,'supplier',1,'draft','po') RETURNING *`, [SUPPLIER, SUP]))[0];
  await q(`INSERT INTO po_lines (po_id, sku, size, qty_expected, unit_cost) VALUES ($1,'DZ5485-612','10',3,110)`, [po.id]);
  // A store paste onto it is refused until the list is under a store.
  expect((await storeList(request, supTok, po.id, TWO_STORES)).status()).toBe(409);
  expect((await act(request, supTok, po.id, 'assign_lines', { storeName: 'AF #1234 Dallas' })).status()).toBe(403);
  expect((await act(request, PH, po.id, 'assign_lines', { storeName: 'AF #1234 Dallas' })).status()).toBe(200);
  const [row] = await q('SELECT by_store FROM purchase_orders WHERE id = $1', [po.id]);
  expect(row.by_store).toBe(true);
  expect((await storeList(request, supTok, po.id, 'Store: AF #2210 New Orleans\nDZ5485-612 $110\n10 x4')).status()).toBe(200);
  expect((await linesOf(po.id)).map((l) => [l.store, l.qty])).toEqual([['AF #1234 Dallas', 3], ['AF #2210 New Orleans', 4]]);
});

test('money evidence: an order or store with a recorded card charge can’t be deleted or removed', async ({ request }) => {
  const po = await create(request);
  await storeList(request, supTok, po.id, TWO_STORES);
  const [st] = await q('SELECT id FROM po_stores WHERE po_id = $1 ORDER BY position LIMIT 1', [po.id]);
  await q('INSERT INTO po_store_charges (po_store_id, amount) VALUES ($1, 330)', [st.id]);
  expect((await act(request, PH, po.id, 'remove', { storeId: st.id })).status()).toBe(409);
  const del = await request.post('/api/po/delete', { headers: hdr(PH), data: { poId: po.id, confirm: po.po_code } });
  expect(del.status()).toBe(409);
  expect((await del.json()).error).toMatch(/audit evidence/);
});

test('the supplier never sees our audit side, on any endpoint that returns the order', async ({ request }) => {
  const po = await create(request);
  await storeList(request, supTok, po.id, TWO_STORES);
  const [st] = await q('SELECT id FROM po_stores WHERE po_id = $1 ORDER BY position LIMIT 1', [po.id]);
  await q('INSERT INTO po_store_charges (po_store_id, amount) VALUES ($1, 330)', [st.id]);
  await q(`UPDATE purchase_orders SET invoice_checked_at = now(), invoice_checked_by = 'staff', audit_note = 'x',
             landed_override_note = 'y', reconciliation = '{"rows":[]}' WHERE id = $1`, [po.id]);
  await q(`UPDATE po_stores SET credit_agreed = 10 WHERE id = $1`, [st.id]);
  const check = (body) => {
    for (const k of PO_SUPPLIER_HIDDEN_KEYS) expect(body.po || {}, `po.${k}`).not.toHaveProperty(k);
    for (const s of body.stores || []) for (const k of STORE_SUPPLIER_HIDDEN_KEYS) expect(s, `store.${k}`).not.toHaveProperty(k);
    expect(body).not.toHaveProperty('batches');
  };
  check(await (await request.get(`/api/po/get?id=${po.id}`, { headers: hdr(supTok) })).json());
  check(await (await act(request, supTok, po.id, 'rename', { storeId: st.id, name: 'AF #1234 Dallas TX' })).json());
  check(await (await storeList(request, supTok, po.id, 'Store: Z\nDZ5485-612 $110\n9 x1')).json());
  const list = await (await request.get('/api/po/list', { headers: hdr(supTok) })).json();
  const mine = list.pos.find((p) => Number(p.id) === Number(po.id));
  for (const k of PO_SUPPLIER_HIDDEN_KEYS) expect(mine, `list.${k}`).not.toHaveProperty(k);
  // Staff still see it.
  const staff = await (await request.get(`/api/po/get?id=${po.id}`, { headers: hdr(PH) })).json();
  expect(staff.po.invoice_checked_by).toBe('staff');
  expect(Number(staff.stores[0].charged_total)).toBe(330);
});

test('portal: a supplier opens a store order, pastes the list, adds a box, confirms', async ({ page }) => {
  await page.addInitScript(([t, u]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u); },
    [supTok, JSON.stringify({ username: 'e2e_store_sup', name: SUPPLIER, role: 'supplier' })]);
  await page.goto('/orders');
  await page.getByRole('button', { name: '+ New shipment' }).click();
  await page.getByLabel(/several stores/).check();
  await expect(page.getByText('How many boxes?')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open shipment' }).click();
  await page.getByRole('button', { name: /Paste the store list/ }).click();
  await page.getByLabel('Paste the store list').fill(TWO_STORES);
  await expect(page.locator('.store-paste-list')).toContainText('AF #2210 New Orleans');
  await page.getByRole('button', { name: /Add 7 pairs from 2 stores · \$770\.00/ }).click();
  await expect(page.getByText(/2 stores · 7 pairs ·/)).toBeVisible();
  await page.locator('details.store-order-store').first().getByRole('button', { name: '+ Add a box' }).click();
  await expect(page.getByText(/Box 1 · no label yet/)).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Confirm the list' }).click();
  await expect(page.getByText(/Confirmed by/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Paste more/ })).toHaveCount(0);
});
