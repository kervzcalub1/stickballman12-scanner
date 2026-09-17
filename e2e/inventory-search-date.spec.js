// A date filter NARROWS a search on /inventory — it doesn't replace it.
//
// Searching and browsing-by-date were treated as two modes: the text search widened the
// date window to "all dates", and `gotoPeriod` (Day / Week / Month / ‹ ›) cleared `q`.
// The server has always taken both at once, so all the clearing did was throw away what
// the user had just typed the moment they tried to narrow it by date.
//
// Widening on search stays — a SKU scoped to today usually finds nothing. Narrowing
// afterwards is a deliberate act and has to survive.
import { test, expect } from '@playwright/test';
import { loginAs, loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const SKU = `E2E-QDATE-${`${Date.now()}`.slice(-6)}`;
const NAME = 'E2E Query Date Runner';

test.beforeEach(async ({ page }) => { page.on('pageerror', (err) => { throw err; }); });

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q("DELETE FROM batches WHERE origin = 'E2E query date' AND NOT EXISTS (SELECT 1 FROM items WHERE batch_id = batches.id)");
  await pool.end();
});

test('a SKU search survives switching the date range, and stays in the URL', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  const res = await page.evaluate(async ([sku, name]) => {
    const r = await fetch('/api/batches/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
      body: JSON.stringify({
        kind: 'existing', noShelf: true, batch: { origin: 'E2E query date' },
        items: [{ name, sku, size: '9W', withBox: true, source: 'manual' }],
      }),
    });
    return { status: r.status, body: await r.json() };
  }, [SKU, NAME]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);

  const search = page.getByPlaceholder(/Scan a VIN or shelf/i);
  await search.fill(SKU);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.locator('.inv-trow, .dcard').filter({ hasText: SKU }).first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`q=${SKU}`));

  // The pair was committed just now, so every one of these windows still contains it —
  // which is what makes "the row is still there" a statement about the QUERY surviving.
  for (const period of ['Month', 'Week', 'Day']) {
    await page.getByRole('button', { name: period, exact: true }).click();
    await expect(search).toHaveValue(SKU);                       // not wiped from the box
    await expect(page).toHaveURL(new RegExp(`q=${SKU}`));        // nor from the URL
    await expect(page.locator('.inv-trow, .dcard').filter({ hasText: SKU }).first()).toBeVisible();
  }

  // Stepping ‹ / › runs through the same function, so it must hold the search too.
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(search).toHaveValue(SKU);
  await expect(page).toHaveURL(new RegExp(`q=${SKU}`));
});
