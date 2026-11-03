// Inventory → Check Shopify (docs/context/inventory.md): the button reads Shopify live and
// lists what it holds for the style. Read-only. The page test accepts either answer — CI
// has no Shopify token, and a failed read must say so rather than "Shopify has none".
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loginAs, loadEnv } from './helpers/auth.js';
import { shopifyHoldings, sizeKey } from '../src/lib/shopifyCheck.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const SKU = `E2E-SHCHK-${`${Date.now()}`.slice(-6)}`;

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q("DELETE FROM batches WHERE origin = 'E2E shopify check' AND NOT EXISTS (SELECT 1 FROM items WHERE batch_id = batches.id)");
  await pool.end();
});

test('lists what Shopify holds, per product, sizes in shoe order (pure)', () => {
  expect(sizeKey('9 W')).toBe(sizeKey('9W'));
  expect(sizeKey('US 10')).toBe('10');
  expect(sizeKey('7.5')).not.toBe(sizeKey('7.5W'));
  const out = shopifyHoldings([
    { productId: 'old', productTitle: 'Old copy', status: 'ARCHIVED', size: '9', qty: 5, price: '90.00' },
    { productId: 'a', productTitle: 'Shoe (X1)', status: 'ACTIVE', size: '10.5', qty: 2, price: '120.00' },
    { productId: 'a', productTitle: 'Shoe (X1)', status: 'ACTIVE', size: '9', qty: 0, price: '120.00' },
    { productId: 'a', productTitle: 'Shoe (X1)', status: 'ACTIVE', size: '10', qty: -1, price: '120.00' },
  ]);
  expect(out.map((p) => p.title)).toEqual(['Shoe (X1)', 'Old copy']);     // the one selling first
  expect(out[0].sizes.map((z) => z.size)).toEqual(['9', '10', '10.5']);
  expect(out[0].total).toBe(2);                                          // an oversold -1 isn't stock
});

test('the button on a SKU row opens a live Shopify check', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  const res = await page.evaluate(async (sku) => {
    const r = await fetch('/api/batches/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
      body: JSON.stringify({ kind: 'existing', noShelf: true, batch: { origin: 'E2E shopify check' },
        items: [{ name: 'E2E Shopify Check Runner', sku, size: '9', withBox: true, source: 'manual' }] }),
    });
    return { status: r.status, body: await r.json() };
  }, SKU);
  expect(res.status, JSON.stringify(res.body)).toBe(200);

  await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(SKU);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  const row = page.locator('.inv-trow, .dcard').filter({ hasText: SKU }).first();
  await row.getByRole('button', { name: '🛍 Shopify', exact: true }).click();
  const modal = page.getByRole('dialog', { name: `Shopify check for ${SKU}` });
  await expect(modal).toBeVisible();
  // A made-up SKU: Shopify answers that nothing carries it, or it can't be read and says so.
  await expect(modal.getByText(/Live from Shopify at|Couldn’t read Shopify/)).toBeVisible({ timeout: 20_000 });
  if (await modal.getByText(/Live from Shopify at/).isVisible()) {
    await expect(modal.getByText(`Shopify holds nothing for ${SKU} — no product carries it.`)).toBeVisible();
  }
  await modal.getByRole('button', { name: 'Close' }).click();
  await expect(modal).toBeHidden();
});
