// Store orders, the audit (PR D of docs/store-orders-plan.md, §4.5–4.7): per store, what was
// declared (the list = the invoice) against what arrived against what the card was charged.
// Short and over per SKU + size, never netted; nothing is "short" before the order has
// landed; Mark audited needs the `audit_po` privilege and freezes the table; a store order
// is never closed by the count alone.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import { hasAnyPriv } from '../src/lib/constants.js';
import { storeAuditCsv } from '../src/lib/storeAudit.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const SUPPLIER = `E2E StoreAudit ${stamp}`;
const SKU = `E2E-SA-${stamp}`;
const hdr = (claims) => ({ Authorization: `Bearer ${signToken(claims)}` });
const PH = hdr({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' });
const ADMIN = hdr({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' });

test.describe.configure({ mode: 'serial' });

let SUP; let SUPTOK; let KEVIN; let KEVTOK; let po; let A; let B; let lA; let lB; let batchId; let emailId;

test.beforeAll(async () => {
  const mk = async (u, role, privs = []) => Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status, privileges) VALUES ($1,$1,'x',$2,'approved',$3)
     ON CONFLICT (username) DO UPDATE SET role = $2, privileges = $3 RETURNING id`, [u, role, privs]))[0].id);
  SUP = await mk('e2e_saud_sup', 'supplier');
  KEVIN = await mk('e2e_saud_kevin', 'ph_team', ['audit_po']);
  SUPTOK = hdr({ uid: SUP, username: 'e2e_saud_sup', name: SUPPLIER, role: 'supplier' });
  KEVTOK = hdr({ uid: KEVIN, username: 'e2e_saud_kevin', name: 'Kevin', role: 'ph_team' });
  [po] = await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, tag_code, status, by_store, manifest_scope, expected_boxes, created_by)
     VALUES ($1, $2, $3, 'receiving', true, 'po', 2, 'e2e') RETURNING id, po_code`, [SUPPLIER, SUP, `SA${stamp}`]);
  [A] = await q(`INSERT INTO po_stores (po_id, name, position) VALUES ($1, 'AF #1 Dallas', 1) RETURNING id`, [po.id]);
  [B] = await q(`INSERT INTO po_stores (po_id, name, position) VALUES ($1, 'AF #2 Austin', 2) RETURNING id`, [po.id]);
  // Store A: 3 × size 9 at $110 and 1 × size 10. Store B: 2 × size 9 at $130.
  await q(`INSERT INTO po_lines (po_id, po_store_id, sku, size, name, qty_expected, unit_cost) VALUES
             ($1, $2, $4, '9', 'E2E SA Shoe', 3, 110), ($1, $2, $4, '10', 'E2E SA Shoe', 1, 110),
             ($1, $3, $4, '9', 'E2E SA Shoe', 2, 130)`, [po.id, A.id, B.id, SKU]);
  [lA] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status, po_store_id) VALUES ($1, 1, $2, 'delivered', $3) RETURNING id`, [po.id, `SAA${stamp}1`, A.id]);
  [lB] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status, po_store_id) VALUES ($1, 2, $2, 'in_transit', $3) RETURNING id`, [po.id, `SAB${stamp}2`, B.id]);
  // Store A's box is in: 2 of the 3 size 9s, the size 10, and an 11 nobody declared.
  const [b] = await q(
    `INSERT INTO batches (batch_code, supplier_name, status, kind, po_id, date_received)
     VALUES ($1, $2, 'committed', 'receiving', $3, current_date) RETURNING id`, [`B-E2ESA-${stamp}`, SUPPLIER, po.id]);
  batchId = Number(b.id);
  await q('UPDATE purchase_orders SET received_batch_id = $1 WHERE id = $2', [batchId, po.id]);
  const [bx] = await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status, po_box_id) VALUES ($1, 1, $2, 'received', $3) RETURNING id`, [batchId, `SAA${stamp}1`, lA.id]);
  await q(`INSERT INTO items (vin, batch_id, box_id, sku, size, name, status) VALUES
             ($1, $5, $6, $7, '9',  'E2E SA Shoe', 'in_stock'), ($2, $5, $6, $7, '9',  'E2E SA Shoe', 'in_stock'),
             ($3, $5, $6, $7, '10', 'E2E SA Shoe', 'in_stock'), ($4, $5, $6, $7, '11', 'E2E SA Shoe', 'in_stock')`,
  [`SBM-E2ESA${stamp}1`, `SBM-E2ESA${stamp}2`, `SBM-E2ESA${stamp}3`, `SBM-E2ESA${stamp}4`, batchId, bx.id, SKU]);
  [{ id: emailId }] = await q(
    `INSERT INTO email_receipts (message_key, received_at, store_name, order_number, total)
     VALUES ($1, now(), 'Athletes Foot', $2, 452.10) RETURNING id`, [`e2e-sa-${stamp}`, `T${stamp}`]);
});

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM batch_boxes WHERE batch_id = $1', [batchId]);
  await q('DELETE FROM batches WHERE id = $1', [batchId]);
  await q('DELETE FROM po_store_receipts WHERE po_store_id IN (SELECT id FROM po_stores WHERE po_id = $1)', [po.id]);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM email_receipts WHERE id = $1', [emailId]);
  await q(`DELETE FROM users WHERE username IN ('e2e_saud_sup','e2e_saud_kevin')`);
  await pool.end();
});

const audit = async (request, h = PH) => (await request.get(`/api/po/audit?poId=${po.id}`, { headers: h })).json();
const act = (request, action, extra = {}, h = PH) => request.post('/api/po/audit', { headers: h, data: { poId: po.id, action, ...extra } });
const store = (v, id) => v.variance.stores.find((s) => s.store_id === Number(id));

test('audit_po is a privilege on top of a job, and draws no Buying Requests card', () => {
  expect(hasAnyPriv({ role: 'ph_team', privileges: ['audit_po'] })).toBe(false);
  expect(hasAnyPriv({ role: 'ph_team', privileges: ['approve_buying'] })).toBe(true);
});

test('before it has landed, the boxes are "still arriving" and it cannot be audited', async ({ request }) => {
  const v = await audit(request);
  expect(v.variance.landed).toMatchObject({ landed: false, labels: 2, labels_in: 1 });
  expect(v.can).toEqual({ audit: false, unaudit: false });   // e2e-ph holds no audit_po
  const r = await act(request, 'mark_audited', {}, KEVTOK);
  expect(r.status()).toBe(409);
  expect((await r.json()).error).toMatch(/1 of 2 boxes in/);
  // A plain Reconcile is refused for a store order — the audit closes it.
  const rc = await request.post('/api/po/reconcile', { headers: PH, data: { poId: po.id } });
  expect(rc.status()).toBe(409);
});

test('card charges per store — a credit is negative — and only staff enter them', async ({ request }) => {
  expect((await act(request, 'charge_add', { storeId: A.id, amount: 452.1, chargedOn: '2026-10-20', cardLast4: '9876' })).status()).toBe(200);
  expect((await act(request, 'charge_add', { storeId: B.id, amount: 290 })).status()).toBe(200);
  const r = await act(request, 'charge_add', { storeId: B.id, amount: -20, note: 'price adjustment' });
  const v = await r.json();
  expect(store(v, A.id)).toMatchObject({ charged_total: 452.1, declared_total: 440, charged_minus_declared: 12.1 });
  expect(store(v, B.id)).toMatchObject({ charged_total: 270, declared_total: 260, charged_minus_declared: 10 });
  expect(v.charges.find((c) => c.card_last4 === '9876')).toBeTruthy();
  expect((await act(request, 'charge_add', { storeId: A.id, amount: 1 }, SUPTOK)).status()).toBe(403);
  // A store from another order is not this order's.
  expect((await act(request, 'charge_add', { storeId: 999999999, amount: 1 })).status()).toBe(400);
});

test('receipts: the supplier adds and totals their own; staff attach an email; the supplier sees only theirs', async ({ request }) => {
  // Attach is checked against the key receipt-sign hands out (no bucket needed here).
  const bad = await request.post('/api/po/receipt-attach', { headers: SUPTOK, data: { poId: po.id, storeId: A.id, key: 'buy-carts/x/receipt-1.jpg' } });
  expect(bad.status()).toBe(400);
  const att = await request.post('/api/po/receipt-attach', { headers: SUPTOK,
    data: { poId: po.id, storeId: A.id, key: `po-receipts/${po.po_code}/${A.id}-${Date.now()}.jpg`, name: 'dallas.jpg', contentType: 'image/jpeg' } });
  expect(att.status()).toBe(200);
  const rid = (await att.json()).receipt.id;
  expect((await act(request, 'receipt_amount', { receiptId: rid, amount: 452.1 }, SUPTOK)).status()).toBe(200);
  // Staff attach an ingested email receipt to store B.
  const em = await (await request.get(`/api/po/receipt-emails?poId=${po.id}&total=270`, { headers: PH })).json();
  expect(em.receipts.some((e) => Number(e.id) === Number(emailId))).toBe(true);
  expect((await request.get(`/api/po/receipt-emails?poId=${po.id}`, { headers: SUPTOK })).status()).toBe(403);
  const v = await (await act(request, 'receipt_email', { storeId: B.id, emailReceiptId: emailId })).json();
  expect(store(v, A.id).receipt_total).toBe(452.1);
  expect(store(v, B.id).receipt_total).toBe(452.1);           // the email's total, as filed
  // The supplier's view: only their own receipt, nothing of ours.
  const sv = await audit(request, SUPTOK);
  expect(Object.keys(sv).sort()).toEqual(['ok', 'receipts']);
  expect(sv.receipts.map((r) => r.id)).toEqual([rid]);
  expect(sv.receipts[0].email_receipt_id).toBeUndefined();
  // …and they can't change a receipt staff attached.
  const staffReceipt = v.receipts.find((r) => r.email_receipt_id);
  expect((await act(request, 'receipt_remove', { receiptId: staffReceipt.id }, SUPTOK)).status()).toBe(403);
});

test('called landed: short and over per size, never netted, and what the shortfall is worth', async ({ request }) => {
  const v = await (await act(request, 'landed', { note: 'Austin box lost — claim filed' })).json();
  expect(v.variance.landed).toMatchObject({ landed: true, all_in: false });
  const a = store(v, A.id);
  // 2 of 3 size 9 (1 short, $110), the size 10, an undeclared 11 (over) — the 11 does not
  // pay for the missing 9.
  expect(a).toMatchObject({ declared_units: 4, received_units: 4, short: 1, over: 1, owed: 110 });
  const b = store(v, B.id);
  expect(b).toMatchObject({ declared_units: 2, received_units: 0, short: 2, owed: 260 });
  expect(v.variance.totals).toMatchObject({ short: 3, over: 1, owed: 370, stores_short: 2, overcharge: 22.1 });
  // The CSV is built from the same object.
  const csv = storeAuditCsv(v.variance);
  expect(csv).toContain('AF #1 Dallas,4,440.00,452.10,452.10,4,1,1,110.00,12.10');
  expect(csv).toMatch(new RegExp(`AF #2 Austin,${SKU},9,2,0,2,0,130.00,260.00`));
});

test('the store alert speaks per store, once landed — and a store order never auto-closes', async () => {
  const { storeOutcomeForIntake, autoReconcileIfClean } = await import('../api/_lib/db.js');
  const rc = await storeOutcomeForIntake(po.id);
  expect(rc).toMatchObject({ byStore: true, storesShort: 2, storeCount: 2, short: 3, owed: 370 });
  expect(rc.top.map((s) => s.name)).toEqual(['AF #2 Austin', 'AF #1 Dallas']);
  expect(await autoReconcileIfClean(po.id)).toBeNull();
  expect((await q('SELECT status FROM purchase_orders WHERE id = $1', [po.id]))[0].status).toBe('receiving');
});

test('Mark audited needs audit_po, freezes the table, and locks the money; only an admin undoes it', async ({ request }) => {
  expect((await act(request, 'mark_audited', { note: 'x' })).status()).toBe(403);          // ph_team without it
  const r = await act(request, 'mark_audited', { note: 'Joey credits $370' }, KEVTOK);
  expect(r.status()).toBe(200);
  const [row] = await q('SELECT status, audited_by, audit_note, audit_snapshot FROM purchase_orders WHERE id = $1', [po.id]);
  expect(row).toMatchObject({ status: 'reconciled', audited_by: 'Kevin', audit_note: 'Joey credits $370' });
  expect(row.audit_snapshot.totals.owed).toBe(370);
  // Money evidence is frozen now.
  expect((await act(request, 'charge_add', { storeId: A.id, amount: 5 })).status()).toBe(409);
  // The supplier never reads the audit.
  const sup = await (await request.get(`/api/po/get?id=${po.id}`, { headers: SUPTOK })).json();
  expect(sup.po.audit_snapshot).toBeUndefined();
  expect(sup.po.audited_by).toBeUndefined();
  // Undo: admin only.
  expect((await act(request, 'unaudit', {}, KEVTOK)).status()).toBe(403);
  expect((await act(request, 'unaudit', {}, ADMIN)).status()).toBe(200);
  const [after] = await q('SELECT status, audited_at, audit_snapshot, reconciliation FROM purchase_orders WHERE id = $1', [po.id]);
  expect(after).toEqual({ status: 'receiving', audited_at: null, audit_snapshot: null, reconciliation: null });
});

test('a replacement reopening the order supersedes the audit, and says what it read', async ({ request }) => {
  expect((await act(request, 'mark_audited', {}, KEVTOK)).status()).toBe(200);
  const { reopenPoForReceiving } = await import('../api/_lib/db.js');
  expect(await reopenPoForReceiving(po.id)).toBeTruthy();
  const [row] = await q('SELECT status, audited_at FROM purchase_orders WHERE id = $1', [po.id]);
  expect(row).toEqual({ status: 'receiving', audited_at: null });
  const [c] = await q(`SELECT body FROM po_comments WHERE po_id = $1 AND body LIKE 'Reopened for receiving%' ORDER BY id DESC LIMIT 1`, [po.id]);
  expect(c.body).toMatch(/3 short.*\$370\.00 owed/);
});

test('a receipt photo is read twice: agreeing totals prefill, disagreeing ones are flagged', async () => {
  let n = 0;
  const totals = [452.1, 452.1, 452.1, 425.1];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const t = totals[n++];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        rows: [{ sku: SKU, size: '9', qty: 2, totalPrice: 220 }], subtotal: 220, tax: null, statedTotal: t, itemsSold: 2,
      }) } }] }));
    });
  });
  await new Promise((ok) => server.listen(5195, '127.0.0.1', ok));
  try {
    process.env.OPENAI_API_KEY = 'e2e-fake';
    process.env.RECEIPT_AI_URL = 'http://127.0.0.1:5195/v1/chat/completions';
    const { readReceiptTwice } = await import('../api/_lib/receipt-ai.js');
    const img = Buffer.from('not really a jpeg');
    const one = await readReceiptTwice(img);
    expect(one).toMatchObject({ agreed: true, statedTotal: 452.1, totals: [452.1, 452.1] });
    expect(one.rows[0]).toMatchObject({ sku: SKU, qty: 2, unitPrice: 110 });
    const two = await readReceiptTwice(img);
    expect(two.agreed).toBe(false);
    expect(two.totals.sort()).toEqual([425.1, 452.1]);
  } finally { server.close(); }
});

test('the audit panel on the order: stores, quantities first, nothing "short" shown as money before landing', async ({ page, request }) => {
  await act(request, 'landed', { note: null });   // back to "still arriving"
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?po=${po.id}`);
  const panel = page.locator('.store-audit');
  await expect(panel).toContainText('Audit — by store', { timeout: 15_000 });
  await expect(panel).toContainText('1 of 2 boxes in — still arriving');
  const rowA = panel.locator('.store-audit-row', { hasText: 'AF #1 Dallas' });
  await expect(rowA.locator('td').nth(6)).toHaveText('—');          // Short: not until it lands
  await rowA.click();
  await expect(panel.locator('.store-audit-detail')).toContainText('Card charges');
  await expect(panel.locator('.store-audit-detail')).toContainText('$452.10');
  await expect(panel.getByRole('button', { name: 'Call it landed…' })).toBeVisible();
  // e2e-ph doesn't hold audit_po: no Mark audited button is drawn.
  await expect(panel.getByRole('button', { name: 'Mark audited' })).toHaveCount(0);
});
