// The store audit's three follow-ups (docs/store-orders-plan.md §4.6, after PR D):
//   · a receipt's LINES against Joey's list for that store ("the receipt has 2 more …");
//   · the audit as a PDF, from the same object as the screen and the CSV;
//   · a PDF receipt read from its own text in the browser (no AI).
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import { compareReceiptToList, receiptDiffSentence } from '../src/lib/storeAudit.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const SUPPLIER = `E2E AuditExtras ${stamp}`;
const SKU = `E2E-AX-${stamp}`;

test.describe.configure({ mode: 'serial' });
let po; let A;

test.beforeAll(async () => {
  [po] = await q(`INSERT INTO purchase_orders (supplier_name, status, by_store, manifest_scope, created_by)
                  VALUES ($1, 'receiving', true, 'po', 'e2e') RETURNING id, po_code`, [SUPPLIER]);
  [A] = await q(`INSERT INTO po_stores (po_id, name, position) VALUES ($1, 'AF #9 Tyler', 1) RETURNING id`, [po.id]);
  await q(`INSERT INTO po_lines (po_id, po_store_id, sku, size, name, qty_expected, unit_cost) VALUES
             ($1, $2, $3, '9', 'E2E AX Shoe', 2, 100), ($1, $2, $3, '10', 'E2E AX Shoe', 1, 100)`, [po.id, A.id, SKU]);
  // The store's receipt, read: 2 × size 9 and 3 × size 10 — two more 10s than the list.
  await q(`INSERT INTO po_store_receipts (po_store_id, name, amount, lines) VALUES ($1, 'tyler.pdf', 500, $2)`,
    [A.id, JSON.stringify([{ sku: SKU, size: '9', qty: 2, totalPrice: 200 }, { sku: SKU, size: '10W', qty: 3, totalPrice: 300 }])]);
});
test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

test('a receipt\'s lines against the store\'s list — by size, or shoe by shoe when it prints none', () => {
  const store = { skus: [{ sizes: [{ sku: 'DZ5485-612', size: '10', declared: 3 }, { sku: 'DZ5485-612', size: '9', declared: 1 }] }] };
  const r = compareReceiptToList([{ sku: 'dz5485612', size: '10W', qty: 5 }, { sku: 'IB4025-100', size: '8', qty: 1 }], store);
  expect(r.bySize).toBe(true);
  expect(r.diffs.map(receiptDiffSentence)).toEqual([
    'on the list, not on the receipt: 1 × DZ5485-612 size 9',
    'the receipt has 2 more DZ5485-612 size 10 than the list (5 vs 3)',
    'on the receipt, not on the list: 1 × IB4025-100 size 8',
  ]);
  // No sizes on the receipt: 4 pairs of the shoe against 4 listed is a match, not 4 gaps.
  expect(compareReceiptToList([{ sku: 'DZ5485-612', qty: 4 }], store)).toEqual({ bySize: false, diffs: [] });
});

test('the audit panel says what the receipt disagrees with, and exports the audit as a PDF whose text reads back', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?po=${po.id}`);
  const panel = page.locator('.store-audit');
  await expect(panel).toContainText('Audit — by store', { timeout: 15_000 });
  await panel.locator('.store-audit-row', { hasText: 'AF #9 Tyler' }).click();
  await expect(panel.locator('.store-receipt-diffs')).toContainText(`the receipt has 2 more ${SKU} size 10 than the list (3 vs 1)`);

  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'PDF' }).click();
  expect((await download).suggestedFilename()).toBe(`audit-${po.po_code}.pdf`);

  // The same PDF machinery, read back with the browser's PDF text reader (what a PDF
  // receipt goes through): the store, its numbers and the order are on the page.
  const text = await page.evaluate(async (poId) => {
    const { api } = await import('/src/api.js');
    const { buildStoreAuditPdf } = await import('/src/lib/storeAuditPdf.js');
    const { textFromPdf } = await import('/src/lib/pdfText.js');
    const { variance } = await api.poAudit(poId);
    const doc = await buildStoreAuditPdf(variance, { po: { po_code: 'PO-TEXT' } });
    return textFromPdf(doc.output('blob'));
  }, Number(po.id));
  expect(text).toContain('store audit');
  expect(text).toContain('AF #9 Tyler');
  expect(text).toContain('PO-TEXT');
  expect(text).toMatch(/\$300\.00/);          // declared $ for the store
});

test('a PDF receipt\'s total is read from its own text', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/po-status');
  const out = await page.evaluate(async () => {
    const { lazyImport } = await import('/src/lib/chunkLoad.js');
    const JsPDF = await lazyImport(async () => { const m = await import('/node_modules/.vite/deps/jspdf.js').catch(() => import('jspdf')); return m.jsPDF || m.default; });
    const doc = new JsPDF();
    ['THE ATHLETE\'S FOOT #1234', 'DZ5485-612 Air Jordan 1', '  10   1   110.00', 'Subtotal 110.00', 'Tax 9.08', 'Total 119.08']
      .forEach((l, i) => doc.text(l, 10, 20 + i * 8));
    const { textFromPdf } = await import('/src/lib/pdfText.js');
    const { parseReceipt } = await import('/src/lib/receiptParse.js');
    return parseReceipt(await textFromPdf(doc.output('blob')), { source: 'pdf' }).statedTotal;
  });
  expect(out).toBe(119.08);
});
