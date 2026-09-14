// A size chip on an Inventory row is a FILTER, not a label. 42 pairs across nine sizes
// is a wall; the question on the floor is "where are the 7Ws". Tapping a chip opens the
// row narrowed to that size, every action in the detail acts on that set and says so
// in its count, and tapping the chip again widens it back.
import { test, expect } from '@playwright/test';
import { loginAs, loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const SKU = `E2E-SZCHIP-${`${Date.now()}`.slice(-6)}`;
const NAME = 'E2E Size Chip Runner';

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q("DELETE FROM batches WHERE origin = 'E2E size chip' AND NOT EXISTS (SELECT 1 FROM items WHERE batch_id = batches.id)");
  await pool.end();
});

test('tapping a size chip narrows the row to that size, and again widens it', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  // Three 7W + one 9W, through the real commit endpoint so the row is what the floor sees.
  const res = await page.evaluate(async ([sku, name]) => {
    const r = await fetch('/api/batches/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
      body: JSON.stringify({
        kind: 'existing', noShelf: true, batch: { origin: 'E2E size chip' },
        items: [
          { name, sku, size: '7W', withBox: true, source: 'manual' },
          { name, sku, size: '7W', withBox: true, source: 'manual' },
          { name, sku, size: '7W', withBox: true, source: 'manual' },
          { name, sku, size: '9W', withBox: true, source: 'manual' },
        ],
      }),
    });
    return { status: r.status, body: await r.json() };
  }, [SKU, NAME]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);

  await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(SKU);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  const row = page.locator('.inv-trow, .dcard').filter({ hasText: SKU }).first();
  await expect(row).toBeVisible();

  // The chip on the CLOSED row opens it, already narrowed.
  await row.locator('.szq-chip.pick', { hasText: '7W' }).click();
  const detail = page.locator('.inv-detail').first();
  await expect(detail).toBeVisible();
  await expect(detail.locator('.inv-unit-row')).toHaveCount(3);
  await expect(detail.locator('.inv-unit-row')).not.toContainText(['US 9W']);
  await expect(detail.locator('.inv-history-title')).toContainText('size 7W (3)');
  await expect(detail.getByRole('button', { name: /Print labels \(3\)/ })).toBeVisible();
  await expect(detail.locator('.inv-status-edit')).toContainText('size 7W · 3');
  await expect(detail.locator('.szq-chip.pick.on')).toHaveText(/7W/);

  // Another size swaps the filter; the same size again clears it; "Show all" too.
  await detail.locator('.szq-chip.pick', { hasText: '9W' }).click();
  await expect(detail.locator('.inv-unit-row')).toHaveCount(1);
  await expect(detail.locator('.inv-unit-row')).toContainText('US 9W');
  await detail.locator('.szq-chip.pick', { hasText: '9W' }).click();
  await expect(detail.locator('.inv-unit-row')).toHaveCount(4);
  await expect(detail.getByRole('button', { name: /Print labels \(4\)/ })).toBeVisible();
  await expect(detail.locator('.szq-chip.pick.on')).toHaveCount(0);
  await detail.locator('.szq-chip.pick', { hasText: '7W' }).click();
  await page.screenshot({ path: '/Users/kervz/.claude/jobs/42ada988/tmp/size-chip.png' });
  await detail.getByRole('button', { name: /Show all 4/ }).click();
  await expect(detail.locator('.inv-unit-row')).toHaveCount(4);
  // …and the row stayed open throughout — a chip never toggles the accordion shut.
  await expect(detail).toBeVisible();
});
