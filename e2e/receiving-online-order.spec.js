// Receive New reads PH's online orders (2026-10-01). A parcel whose tracking number is on
// an online order says what it should hold, and each pair's cost comes from the order's
// ACTUAL cost for that SKU + size (coupon, tax, shipping and gift card already spread) —
// with what was paid saved as the pair's shelf price, for the audit.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';

const PH = { Authorization: `Bearer ${signToken({ uid: 'oo-ph', username: 'oo_ph', name: 'OO PH', role: 'ph_team' })}` };
const stamp = `${Date.now()}`.slice(-7);
const SKU = `E2E-OOR-${stamp}`;
const TRACK = `1ZOOR${stamp}`;
let db; let orderId;

test.beforeAll(async ({ request }) => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  // 2 × $100 with a $20 coupon and $16 tax → $98 a pair.
  const r = await request.post('/api/online-orders/save', { headers: PH, data: {
    store: 'E2E-OO Receive', tracking_number: TRACK, coupon: 20, tax: 16,
    lines: [{ sku: SKU, size: '9', qty: 2, unit_price: 100 }],
  } });
  expect(r.ok(), await r.text()).toBeTruthy();
  orderId = (await r.json()).id;
});

test.afterAll(async () => {
  await db.query('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  const b = await db.query('SELECT DISTINCT batch_id FROM items WHERE sku = $1', [SKU]);
  await db.query('DELETE FROM items WHERE sku = $1', [SKU]);
  for (const { batch_id: id } of b.rows) await db.query('DELETE FROM batches WHERE id = $1', [id]).catch(() => {});
  await db.query(`DELETE FROM online_orders WHERE store LIKE 'E2E-OO%'`);
  await db.end();
});

test('an online order’s parcel says what it holds, and its pairs land at the order’s actual cost', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.route('**/api/sku-search', (route) => route.fulfill({
    json: { ok: true, product: { name: 'E2E OO Receive Shoe', sku: SKU, image: '', source: 'manual', scannedSize: '9', sizes: ['9'] } },
  }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  // Typed with a space and lower case, the way a number gets copied from an email.
  await page.locator('.track-field input').first().fill(`1zoor ${stamp}`);
  const banner = page.locator('.oo-recv-banner').first();
  await expect(banner).toContainText(`OO-${String(orderId).padStart(4, '0')}`, { timeout: 10_000 });
  await expect(banner).toContainText(`${SKU} US 9 ×2`);
  await page.locator('.manifest-q').getByRole('button', { name: 'Yes' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();

  for (let i = 0; i < 2; i += 1) {
    await page.locator('.scanbar input').first().fill(SKU);
    await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  }
  const card = page.locator(`.recv-item[data-sku="${SKU}"]`);
  await expect(card.locator('.recv-item-cost-src')).toContainText('from online order', { timeout: 10_000 });
  await expect(card.locator('.recv-item-cost input')).toHaveAttribute('placeholder', '98.00');

  await page.getByRole('button', { name: 'Review →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });

  const rows = (await db.query('SELECT cost, shelf_price FROM items WHERE sku = $1', [SKU])).rows;
  expect(rows).toHaveLength(2);
  for (const r of rows) { expect(Number(r.cost)).toBe(98); expect(Number(r.shelf_price)).toBe(100); }
});

test('a tracking number that is no online order changes nothing', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.locator('.track-field input').first().fill(`1ZNOTANORDER${stamp}`);
  await page.waitForTimeout(1200);
  await expect(page.locator('.oo-recv-banner')).toHaveCount(0);
});

// QA pass #2, finding 1: a multi-box receive with box 1 = order A and box 2 = order B costed
// a box-2 pair off order A whenever both orders carried that SKU + size (the first order in
// the list won), and a shoe only on A's order was costed in box 2 too. Each box now uses
// ITS OWN parcel's order.
test('a multi-box receive costs each box from its own online order', async ({ page, request }) => {
  const S = `${SKU}-M`; const X = `${SKU}-X`;
  const mk = async (tracking, lines) => {
    const r = await request.post('/api/online-orders/save', { headers: PH, data: { store: 'E2E-OO Multi', tracking_number: tracking, lines } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).id;
  };
  await mk(`1ZOOMA${stamp}`, [{ sku: S, size: '9', qty: 1, unit_price: 50 }, { sku: X, size: '9', qty: 1, unit_price: 51 }]);
  const bId = await mk(`1ZOOMB${stamp}`, [{ sku: S, size: '9', qty: 1, unit_price: 80 }]);

  await loginAs(page, 'warehouse');
  await page.route('**/api/sku-search', (route) => {
    const sku = String(route.request().postDataJSON()?.sku || '').toUpperCase();
    return route.fulfill({ json: { ok: true, product: { name: `E2E OO ${sku.slice(-1)}`, sku, image: '', source: 'manual', scannedSize: '9', sizes: ['9'] } } });
  });
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('label:has-text("Boxes expected") input').fill('2');
  await page.locator('.manifest-q').getByRole('button', { name: 'Yes' }).click();
  const rows = page.locator('.box-build-row');
  await expect(rows).toHaveCount(2);
  await rows.nth(0).locator('.box-build-track input').fill(`1ZOOMA${stamp}`);
  await rows.nth(1).locator('.box-build-track input').fill(`1ZOOMB${stamp}`);
  await page.waitForTimeout(1200);   // the lookup's pause
  await rows.nth(1).getByRole('button', { name: 'Add items' }).click();

  await expect(page.locator('.oo-recv-banner')).toHaveCount(1);
  await expect(page.locator('.oo-recv-banner')).toContainText(`OO-${String(bId).padStart(4, '0')}`);
  for (const code of [S, X]) {
    await page.locator('.scanbar input').first().fill(code);
    await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  }
  const card = (sku) => page.locator(`.recv-item[data-sku="${sku}"]`);
  await expect(card(S).locator('.recv-item-cost input')).toHaveAttribute('placeholder', '80.00');
  await expect(card(S).locator('.recv-item-cost-src')).toContainText(`OO-${String(bId).padStart(4, '0')}`);
  // X is only on box 1's order — nothing to take from box 2's.
  await expect(card(X).locator('.recv-item-cost-src')).not.toContainText('online order');
});

