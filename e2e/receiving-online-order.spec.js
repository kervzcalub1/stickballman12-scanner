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
