// Supplier scan-out: a scan gun can fire box after box without stopping.
//
// Reported 2026-11-04: suppliers "cannot rapid scan". The Add-items window disabled its
// scan field for every lookup — a disabled field drops focus, so every scan after the
// first went nowhere until someone tapped the field again. On top of that, the same UPC
// within 1.2s was thrown away as a "re-read" (six boxes of one size scanned fast = six
// pairs, not one), and every new SKU stopped on an "Add & switch" popup.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const SUPPLIER = 'E2E Rapid Scan Supplier';
const USERNAME = 'e2e_rapid_scan_sup';
let SUP;

const SHOES = {
  '190000000101': { name: 'E2E Rapid Runner', sku: 'E2ERS-001', scannedSize: '9' },
  '190000000202': { name: 'E2E Rapid Court', sku: 'E2ERS-002', scannedSize: '10.5' },
};

test.beforeAll(async () => {
  SUP = Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$2,'x','supplier','approved')
     ON CONFLICT (username) DO UPDATE SET role='supplier', name=$1 RETURNING id`, [SUPPLIER, USERNAME]))[0].id);
});
test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_user_id = $1', [SUP]);
  await q('DELETE FROM users WHERE username = $1', [USERNAME]);
  await pool.end();
});

test('a gun scanning fast: every box counts, the field keeps focus, a new SKU needs no tap', async ({ page }) => {
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, raised_by, expected_boxes, status)
     VALUES ($1,$2,'supplier',1,'draft') RETURNING *`, [SUPPLIER, SUP]))[0];
  const box = (await q(`INSERT INTO po_boxes (po_id, box_number, status) VALUES ($1, 1, 'pending') RETURNING id`, [po.id]))[0];

  const tok = signToken({ uid: SUP, username: USERNAME, name: SUPPLIER, role: 'supplier' });
  await page.addInitScript(([t, u]) => {
    sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u);
  }, [tok, JSON.stringify({ username: USERNAME, name: SUPPLIER, role: 'supplier' })]);

  // A catalogue that takes its time — slower than the gun, which is the whole point.
  await page.route('**/api/upc-search', async (route) => {
    const upc = String(route.request().postDataJSON()?.upc || '');
    await new Promise((r) => setTimeout(r, 400));
    const s = SHOES[upc];
    if (!s) return route.fulfill({ status: 404, json: { ok: false, error: 'No product found for that UPC.' } });
    return route.fulfill({ json: { ok: true, product: { ...s, upc, image: '', source: 'manual', sizes: ['8', '9', '10', '10.5', '11'] } } });
  });

  await page.goto('/orders');
  await page.locator('.po-card').filter({ hasText: po.po_code }).first().click();
  await page.getByRole('button', { name: /^Add items$/ }).first().click();
  const field = page.getByPlaceholder(/Scan or type UPC/i);
  await expect(field).toBeFocused();

  // What a gun does: types the code and presses Enter, back to back, no waiting.
  const gun = async (code) => { await page.keyboard.type(code, { delay: 5 }); await page.keyboard.press('Enter'); };
  await gun('190000000101');
  await gun('190000000101');
  await gun('190000000101');
  await gun('190000000202');
  await gun('999999999999'); // a box the catalogue doesn't know

  // The field was never taken away from the gun.
  await expect(field).toBeEnabled();
  await expect(field).toBeFocused();

  // Shoe 1 went onto the label by itself when shoe 2 was scanned: 3 pairs, not 1.
  await expect.poll(async () => (await q(
    `SELECT sku, size, qty_expected FROM po_lines WHERE po_box_id = $1 ORDER BY sku`, [box.id]))
    .map((l) => `${l.sku} ${l.size} ×${l.qty_expected}`), { timeout: 15_000 })
    .toEqual(['E2ERS-001 9 ×3']);
  await expect(page.getByRole('heading', { name: 'Different shoe detected' })).toHaveCount(0);

  // Shoe 2 is the open draft, and the unknown box is listed rather than flashed away.
  await expect(page.locator('.additem-draft input[placeholder="SKU"]')).toHaveValue('E2ERS-002');
  await expect(page.locator('.po-scan-failed')).toContainText('999999999999');

  // Tapping a size chip hands focus back to the field, so the gun's Enter can't press
  // the chip a second time.
  await page.locator('.size-chips .size-chip', { hasText: /^11$/ }).click();
  await expect(field).toBeFocused();
  await page.getByRole('button', { name: /^Add 2 units to label$/ }).click();
  await expect.poll(async () => (await q(
    `SELECT sku, size, qty_expected FROM po_lines WHERE po_box_id = $1 ORDER BY sku, size`, [box.id]))
    .map((l) => `${l.sku} ${l.size} ×${l.qty_expected}`), { timeout: 15_000 })
    .toEqual(['E2ERS-001 9 ×3', 'E2ERS-002 10.5 ×1', 'E2ERS-002 11 ×1']);
});
